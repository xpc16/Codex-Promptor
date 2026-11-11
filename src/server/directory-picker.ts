import { execFile, type ChildProcess } from "node:child_process";

const DIRECTORY_PICKER_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择工作文件夹（进入目标文件夹后点击“选择当前文件夹”）'
$dialog.InitialDirectory = $env:CODEX_PROMPTOR_PICKER_INITIAL_PATH
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.ValidateNames = $false
$dialog.DereferenceLinks = $true
$dialog.RestoreDirectory = $true
$dialog.AutoUpgradeEnabled = $true
$dialog.AddExtension = $false
$dialog.Multiselect = $false
$dialog.FileName = '选择当前文件夹'

try {
  $owner.Show()
  $owner.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.FileName
    if (Test-Path -LiteralPath $selected -PathType Container) {
      $folder = (Resolve-Path -LiteralPath $selected).Path
    } else {
      $folder = [System.IO.Path]::GetDirectoryName($selected)
    }
    if ($folder) { [Console]::Out.Write($folder) }
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}`;

const MACOS_DIRECTORY_PICKER_SCRIPT = String.raw`
on run argv
  try
    set initialFolder to (POSIX file (item 1 of argv)) as alias
    activate
    set selectedFolder to choose folder with prompt "Select a working folder" default location initialFolder
    return POSIX path of selectedFolder
  on error errorMessage number errorNumber
    if errorNumber is -128 then return ""
    error errorMessage number errorNumber
  end try
end run`;

export function supportsNativeDirectoryPicker(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export class DirectoryPickerBusyError extends Error {
  constructor() {
    super("A directory picker is already open.");
    this.name = "DirectoryPickerBusyError";
  }
}

export type DirectoryPickerRunner = {
  run(initialPath: string): Promise<string | null>;
  stop(): Promise<void>;
};

export class NativeDirectoryPickerRunner implements DirectoryPickerRunner {
  private child: ChildProcess | null = null;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async run(initialPath: string): Promise<string | null> {
    if (!supportsNativeDirectoryPicker(this.platform)) throw new Error("The native folder picker is available on Windows and macOS.");
    if (this.child) throw new DirectoryPickerBusyError();
    const macos = this.platform === "darwin";
    // Pass the path as data, never embed it in AppleScript or a shell command.
    const command = macos ? "/usr/bin/osascript" : "powershell.exe";
    const args = macos
      ? ["-e", MACOS_DIRECTORY_PICKER_SCRIPT, initialPath]
      : ["-NoProfile", "-STA", "-Command", DIRECTORY_PICKER_SCRIPT];
    return new Promise<string | null>((resolve, reject) => {
      const child = execFile(command, args, {
        windowsHide: false,
        timeout: 600_000,
        encoding: "utf8",
        env: { ...process.env, CODEX_PROMPTOR_PICKER_INITIAL_PATH: initialPath },
      }, (error, stdout) => {
        if (this.child === child) this.child = null;
        if (error) reject(error);
        else {
          // osascript appends a newline; spaces can belong to a POSIX path.
          const selected = macos ? String(stdout).replace(/\r?\n$/, "") : String(stdout).trim();
          resolve(selected || null);
        }
      });
      this.child = child;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2_000);
      child.once("exit", finish);
      try { if (!child.kill()) finish(); } catch { finish(); }
    });
  }
}

export class DirectoryPickerService {
  private active = false;

  constructor(private readonly runner: DirectoryPickerRunner = new NativeDirectoryPickerRunner()) {}

  async select(initialPath: string): Promise<string | null> {
    if (this.active) throw new DirectoryPickerBusyError();
    this.active = true;
    try { return await this.runner.run(initialPath); }
    finally { this.active = false; }
  }

  async stop(): Promise<void> {
    await this.runner.stop();
    this.active = false;
  }
}
