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

    static void Main() {
        try {
            var config = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-helper.config"));
            if (config.Length > 2) healthUrl = config[2];
            var input = Console.OpenStandardInput();
            var size = new byte[4];
            if (input.Read(size, 0, 4) != 4) return;
            int length = BitConverter.ToInt32(size, 0);
            if (length < 1 || length > 4096) throw new Exception("无效的本机消息");
            var body = new byte[length];
            int read = 0;
            while (read < length) {
                int count = input.Read(body, read, length - read);
                if (count == 0) throw new Exception("本机消息未完整传入");
                read += count;
            }
            if (!Encoding.UTF8.GetString(body).Contains("\"start\"")) throw new Exception("不支持的操作");
            if (!Healthy()) {
                var start = new ProcessStartInfo(config[0], "\"" + config[1] + "\"");
                start.UseShellExecute = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(start);
                for (int i = 0; i < 50 && !Healthy(); i++) Thread.Sleep(200);
            }
            Reply(Healthy(), "本机助手启动失败");
        } catch (Exception error) { Reply(false, error.Message); }
    }
}
