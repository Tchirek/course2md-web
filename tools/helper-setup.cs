// Single-file, per-user setup. The helper archive is embedded by build-installer.mjs.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

class HelperSetup
{
    static string Extract(string directory)
    {
        Directory.CreateDirectory(directory);
        string root = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("helper.zip"))
        using (ZipArchive archive = new ZipArchive(payload))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Invalid installer archive path");
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                entry.ExtractToFile(target, true);
            }
        }
        return Path.Combine(root, "tools", "install-helper.ps1");
    }

    static void Install(Action<string> log)
    {
        string scratch = Path.Combine(Path.GetTempPath(), "course2md-setup-" + Guid.NewGuid().ToString("N"));
        try
        {
            string script = Extract(scratch);
            ProcessStartInfo start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                // Windows' default Restricted policy blocks the bundled trusted script. This affects this process only.
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            // A PowerShell 7 parent can pass incompatible module paths into Windows PowerShell 5.1.
            start.EnvironmentVariables.Remove("PSModulePath");
            using (Process child = new Process { StartInfo = start })
            {
                child.OutputDataReceived += (sender, e) => log(e.Data);
                child.ErrorDataReceived += (sender, e) => log(e.Data);
                child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine(); child.WaitForExit();
                if (child.ExitCode != 0) throw new Exception("安装未完成，请检查上方信息后重新运行安装器。");
            }
        }
        finally
        {
            // Only the unique directory created by this invocation is removed; installed files live elsewhere.
            try { Directory.Delete(scratch, true); } catch { }
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        // Packaging smoke check: unpack into a caller-owned scratch folder without installing anything.
        if (args.Length == 2 && args[0] == "--extract")
        {
            try { Extract(args[1]); return 0; }
            catch { return 1; }
        }
        using (Mutex single = new Mutex(false, "Local\\course2md-helper-setup"))
        {
        if (!single.WaitOne(0)) { MessageBox.Show("本机助手正在安装，请等待安装完成。", "course2md"); return 1; }
        if (args.Length == 1 && args[0] == "--quiet")
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            try { Install(Console.WriteLine); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Form form = new Form { Text = "course2md 本机助手", ClientSize = new Size(520, 270),
            StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, Font = SystemFonts.MessageBoxFont, AutoScaleMode = AutoScaleMode.Dpi };
        Label title = new Label { Text = "正在安装本机助手", Left = 24, Top = 24, Width = 470,
            Height = 32, Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 14) };
        Label status = new Label { Text = "准备运行环境，完成后即可返回浏览器。", Left = 24, Top = 66, Width = 470, Height = 36 };
        ProgressBar progress = new ProgressBar { Left = 24, Top = 109, Width = 472, Height = 8,
            Style = ProgressBarStyle.Marquee };
        TextBox details = new TextBox { Left = 24, Top = 135, Width = 472, Height = 73,
            Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BorderStyle = BorderStyle.None,
            BackColor = form.BackColor, TabStop = true };
        Button close = new Button { Text = "完成", Left = 400, Top = 226, Width = 96, Enabled = false };
        form.Controls.AddRange(new Control[] { title, status, progress, details, close });
        close.Click += delegate { form.Close(); };
        bool running = true;
        form.FormClosing += delegate(object sender, FormClosingEventArgs e) { e.Cancel = running; };
        Action<string> log = line => {
            if (String.IsNullOrWhiteSpace(line)) return;
            form.BeginInvoke((Action)(() => { details.AppendText(line + Environment.NewLine); }));
        };
        int result = 1;
        form.Shown += async delegate {
            try
            {
                await Task.Run(() => Install(log));
                result = 0;
                title.Text = "本机助手已就绪";
                status.Text = "返回 course2md 即可使用；模型会在首次使用时自动准备。";
            }
            catch (Exception error) { title.Text = "安装未完成"; status.Text = error.Message; close.Text = "关闭"; }
            finally
            {
                running = false; progress.Visible = false; close.Enabled = true; close.Focus();
            }
        };
        Application.Run(form);
        return result;
        }
    }
}
