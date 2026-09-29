using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

class NativeHelper {
    static string healthUrl = "http://127.0.0.1:8766/health";
    static bool Healthy() {
        try {
            var request = WebRequest.Create(healthUrl);
            request.Timeout = 500;
            using (var response = request.GetResponse()) return true;
        } catch { return false; }
    }

    static void Reply(bool ok, string error) {
        var json = ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
        var bytes = Encoding.UTF8.GetBytes(json);
        var output = Console.OpenStandardOutput();
        var size = BitConverter.GetBytes(bytes.Length);
        output.Write(size, 0, size.Length);
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    // パイプの読み取りは分割して届くことがあるので、長さプレフィックスも本文も読み切る。途中で終わったら false
    static bool ReadExact(Stream input, byte[] buffer) {
        int read = 0;
        while (read < buffer.Length) {
            int count = input.Read(buffer, read, buffer.Length - read);
            if (count == 0) return false;
            read += count;
        }
        return true;
    }

    static void Main() {
        try {
            var configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-helper.config");
            if (!File.Exists(configPath)) throw new Exception("找不到宿主配置 " + configPath);
            var config = File.ReadAllLines(configPath);
            if (config.Length < 2) throw new Exception("宿主配置不完整：" + configPath);
            if (config.Length > 2) healthUrl = config[2];
            var input = Console.OpenStandardInput();
            var size = new byte[4];
            if (!ReadExact(input, size)) return;
            int length = BitConverter.ToInt32(size, 0);
            if (length < 1 || length > 4096) throw new Exception("无效的本机消息");
            var body = new byte[length];
            if (!ReadExact(input, body)) throw new Exception("本机消息未完整传入");
            if (!Encoding.UTF8.GetString(body).Contains("\"start\"")) throw new Exception("不支持的操作");
            if (!Healthy()) {
                // インストール時に記録したパスは無効になり得る（Node の更新で場所が変わった、プロジェクトを移動した等）。どれかを明示する
                if (!File.Exists(config[0])) throw new Exception("找不到 Node：" + config[0]);
                if (!File.Exists(config[1])) throw new Exception("找不到助手脚本：" + config[1]);
                var start = new ProcessStartInfo(config[0], "\"" + config[1] + "\"");
                start.UseShellExecute = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                var child = Process.Start(start);
                for (int i = 0; i < 50 && !Healthy(); i++) {
                    // プロセスが終了済みなら 10 秒待つ必要はない：ポート競合やスクリプトのエラーでこうなる
                    if (child != null && child.HasExited && !Healthy()) {
                        throw new Exception("助手进程启动后立即退出（代码 " + child.ExitCode + "），可在项目目录运行 npm run fast-asr 查看报错");
                    }
                    Thread.Sleep(200);
                }
            }
            Reply(Healthy(), "助手进程 10 秒内未在 " + healthUrl + " 应答");
        } catch (Exception error) { Reply(false, error.Message); }
    }
}
