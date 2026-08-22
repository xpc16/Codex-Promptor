import json
import subprocess
import time
from pathlib import Path
from collections import deque


ROOT = Path(__file__).resolve().parent

PROMPT_FILE = ROOT / "prompt_list.json"
STATE_FILE = ROOT / ".prompt_runner_state.json"

RESULT_LOG = ROOT / "codex_results.log"
LAST_MESSAGE_FILE = ROOT / ".codex_last_message.tmp"

POLL_INTERVAL = 2


# ============================================================
# JSON / STATE
# ============================================================

def load_prompt_config():
    """
    每一轮重新读取 prompt_list.json，
    因此运行过程中可以动态修改 prompt list。

    文件结构：

    {
        "session_id": "...",   # optional
        "prompts": [...]
    }
    """

    try:
        with PROMPT_FILE.open("r", encoding="utf-8") as f:
            config = json.load(f)

        prompts = config.get("prompts", [])

        if not isinstance(prompts, list):
            raise ValueError("'prompts' must be a list")

        return config

    except json.JSONDecodeError:
        print(
            "prompt_list.json 正在修改或 JSON 暂时无效，"
            "稍后重新读取..."
        )
        return None

    except Exception as e:
        print(f"读取 prompt_list.json 失败: {e}")
        return None


def load_state():
    if not STATE_FILE.exists():
        return {
            "session_id": None,
            "completed": []
        }

    try:
        with STATE_FILE.open("r", encoding="utf-8") as f:
            state = json.load(f)

        state.setdefault("session_id", None)
        state.setdefault("completed", [])

        return state

    except Exception:
        return {
            "session_id": None,
            "completed": []
        }


def save_state(state):
    """
    原子写入 state，避免程序异常退出造成 JSON 损坏。
    """

    tmp_file = STATE_FILE.with_suffix(".tmp")

    with tmp_file.open("w", encoding="utf-8") as f:
        json.dump(
            state,
            f,
            ensure_ascii=False,
            indent=2
        )

    tmp_file.replace(STATE_FILE)


# ============================================================
# RESULT LOG
# ============================================================

def append_result(task_id, result):
    """
    只把 Codex 的最终回答写入统一日志。

    不记录：
    - reasoning
    - shell command
    - tool calls
    - JSON event
    - intermediate output
    """

    with RESULT_LOG.open("a", encoding="utf-8") as f:

        f.write("\n")
        f.write("=" * 80 + "\n")
        f.write(f"TASK {task_id}\n")
        f.write("=" * 80 + "\n")

        f.write(result.rstrip())

        f.write("\n")


# ============================================================
# CODEX
# ============================================================

def run_codex(prompt, session_id=None):
    """
    有 session_id:
        codex exec resume SESSION_ID prompt

    无 session_id:
        codex exec prompt
        并通过 --json 获取新 thread_id

    最终回答统一通过：
        --output-last-message

    写入临时文件。
    """

    if LAST_MESSAGE_FILE.exists():
        LAST_MESSAGE_FILE.unlink()

    # --------------------------------------------------------
    # EXISTING SESSION
    # --------------------------------------------------------

    if session_id:

        cmd = [
            "codex",
            "exec",

            "--sandbox",
            "workspace-write",

            "--output-last-message",
            str(LAST_MESSAGE_FILE),

            "resume",
            session_id,
            prompt
        ]

        need_capture_session = False

    # --------------------------------------------------------
    # NEW SESSION
    # --------------------------------------------------------

    else:

        cmd = [
            "codex",
            "exec",

            "--json",

            "--sandbox",
            "workspace-write",

            "--output-last-message",
            str(LAST_MESSAGE_FILE),

            prompt
        ]

        need_capture_session = True

    process = subprocess.Popen(
        cmd,

        cwd=ROOT,

        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,

        text=True,
        encoding="utf-8",
        errors="replace",

        bufsize=1
    )

    detected_session_id = session_id

    # 仅用于运行失败时诊断。
    # 不写入 codex_results.log。
    recent_output = deque(maxlen=30)

    for raw_line in process.stdout:

        line = raw_line.strip()

        if not line:
            continue

        recent_output.append(line)

        # ----------------------------------------------------
        # 只有创建新 session 时才需要解析 JSON
        # ----------------------------------------------------

        if need_capture_session:

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if (
                event.get("type") == "thread.started"
                and event.get("thread_id")
                and detected_session_id is None
            ):
                detected_session_id = event["thread_id"]

    return_code = process.wait()

    # --------------------------------------------------------
    # FINAL ANSWER
    # --------------------------------------------------------

    final_message = None

    if LAST_MESSAGE_FILE.exists():

        final_message = LAST_MESSAGE_FILE.read_text(
            encoding="utf-8"
        ).strip()

    return {
        "return_code": return_code,
        "session_id": detected_session_id,
        "final_message": final_message,
        "recent_output": list(recent_output)
    }


# ============================================================
# TASK QUEUE
# ============================================================

def find_next_task(prompts, completed):

    for task in prompts:

        if not task.get("enabled", True):
            continue

        task_id = str(task["id"])

        if task_id in completed:
            continue

        return task

    return None


def choose_session_id(config, state):
    """
    Session 优先级：

    1. prompt_list.json 显式指定
    2. runner state 中已有 session
    3. None -> 创建新 session
    """

    config_session = config.get("session_id")

    if config_session:

        config_session = str(config_session).strip()

        if config_session:
            return config_session, "prompt_list"

    state_session = state.get("session_id")

    if state_session:

        state_session = str(state_session).strip()

        if state_session:
            return state_session, "state"

    return None, "new"


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 70)
    print("Codex Prompt Queue Runner")
    print("=" * 70)

    print(f"Prompt file : {PROMPT_FILE}")
    print(f"State file  : {STATE_FILE}")
    print(f"Result log  : {RESULT_LOG}")

    while True:

        # ====================================================
        # 每轮重新加载 prompt_list
        # ====================================================

        config = load_prompt_config()

        if config is None:
            time.sleep(POLL_INTERVAL)
            continue

        prompts = config["prompts"]

        state = load_state()

        completed = set(
            str(x)
            for x in state.get("completed", [])
        )

        # ====================================================
        # SESSION
        # ====================================================

        session_id, session_source = choose_session_id(
            config,
            state
        )

        # ====================================================
        # NEXT TASK
        # ====================================================

        task = find_next_task(
            prompts,
            completed
        )

        if task is None:

            print(
                "没有待执行 prompt，等待 prompt_list.json 更新..."
            )

            time.sleep(POLL_INTERVAL)
            continue

        task_id = str(task["id"])
        prompt = task["prompt"]

        # ====================================================
        # STATUS
        # ====================================================

        print()
        print("=" * 70)
        print(f"Running task : {task_id}")

        if session_id:

            print(f"Session      : {session_id}")

            if session_source == "prompt_list":
                print("Session from : prompt_list.json")
            else:
                print("Session from : runner state")

        else:

            print("Session      : NEW")
            print("Session from : creating new Codex session")

        print("=" * 70)

        # ====================================================
        # RUN CODEX
        # ====================================================

        result = run_codex(
            prompt=prompt,
            session_id=session_id
        )

        # ====================================================
        # NEW SESSION CREATED
        # ====================================================

        if (
            session_id is None
            and result["session_id"]
        ):

            state["session_id"] = result["session_id"]

            save_state(state)

            print()
            print(
                "New Codex session created:"
            )
            print(result["session_id"])

        # ====================================================
        # FAILURE
        # ====================================================

        if result["return_code"] != 0:

            print()
            print(f"✗ Task {task_id} failed.")

            print()
            print("Recent Codex output:")

            for line in result["recent_output"]:
                print(line)

            print()
            print("Queue stopped.")

            break

        if not result["final_message"]:

            print()
            print(
                f"✗ Task {task_id} completed "
                "but Codex returned no final message."
            )

            break

        # ====================================================
        # LOG FINAL ANSWER ONLY
        # ====================================================

        append_result(
            task_id,
            result["final_message"]
        )

        # ====================================================
        # COMPLETE TASK
        # ====================================================

        state.setdefault("completed", [])

        state["completed"].append(task_id)

        # 如果当前 session 来自 prompt_list，
        # 同样同步到 state。
        #
        # 这样即使之后从 prompt_list 删除 session_id，
        # runner 仍然知道当前正在使用哪个 session。
        if result["session_id"]:

            state["session_id"] = result["session_id"]

        elif session_id:

            state["session_id"] = session_id

        save_state(state)

        print(
            f"✓ Task {task_id} completed. "
            "Final result appended to log."
        )


if __name__ == "__main__":
    main()