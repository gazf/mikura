using System.Diagnostics;
using System.Text;
using System.Windows.Forms;

namespace Mikura.App.Util;

/// <summary>
/// Redirects Debug.WriteLine, Trace.WriteLine, Console.WriteLine, and Console.Error.WriteLine
/// to mikura-client.log next to the exe. Thread-safe.
/// </summary>
public static class FileLogger
{
    private static readonly object _lock = new();
    private static StreamWriter? _writer;
    private static string? _logPath;

    public static string LogPath => _logPath ?? "(not initialized)";

    public static void Initialize()
    {
        var dir = AppContext.BaseDirectory;
        _logPath = Path.Combine(dir, "mikura-client.log");

        // Append mode; OS-level newline
        var stream = new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.Read);
        _writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = true };

        var listener = new FileListener();
        Trace.Listeners.Add(listener);

        Console.SetOut(new FileTextWriter(isError: false));
        Console.SetError(new FileTextWriter(isError: true));

        // 全域の例外捕捉。fire-and-forget タスクや UI スレッドで投げられた例外も
        // すべて mikura-client.log に集約し、サイレントクラッシュをなくす。
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            Write($"[FATAL] AppDomain.UnhandledException (terminating={e.IsTerminating}): {FormatException(e.ExceptionObject as Exception)}");
        };

        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Write($"[ERROR] UnobservedTaskException: {FormatException(e.Exception)}");
            e.SetObserved(); // プロセス終了を抑制 (.NET 4.5+ 既定でも終了しないが明示)
        };

        Application.ThreadException += (_, e) =>
        {
            Write($"[ERROR] WinForms ThreadException: {FormatException(e.Exception)}");
        };
        // ThreadExceptionDialog ではなく ThreadException ハンドラに流す。
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        Write($"--- mikura-client started at {DateTime.Now:yyyy-MM-dd HH:mm:ss} ---");
    }

    private static string FormatException(Exception? ex)
    {
        if (ex is null) return "(null exception)";
        // インデントなしの ToString() は読みにくいので 1 行ずつ "    " 付きで折り畳む。
        var dump = ex.ToString();
        return Environment.NewLine + string.Join(Environment.NewLine,
            dump.Split('\n').Select(l => "    " + l.TrimEnd('\r')));
    }

    internal static void Write(string line)
    {
        lock (_lock)
        {
            _writer?.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] {line}");
        }
    }

    private sealed class FileListener : TraceListener
    {
        public override void Write(string? message)
        {
            if (message is not null) FileLogger.Write(message);
        }

        public override void WriteLine(string? message)
        {
            if (message is not null) FileLogger.Write(message);
        }
    }

    private sealed class FileTextWriter : TextWriter
    {
        private readonly StringBuilder _buffer = new();
        private readonly bool _isError;

        public FileTextWriter(bool isError) { _isError = isError; }
        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            lock (_buffer)
            {
                if (value == '\n')
                {
                    FileLogger.Write((_isError ? "[err] " : "") + _buffer.ToString().TrimEnd('\r'));
                    _buffer.Clear();
                }
                else
                {
                    _buffer.Append(value);
                }
            }
        }

        public override void Write(string? value)
        {
            if (value is null) return;
            foreach (var ch in value) Write(ch);
        }

        public override void WriteLine(string? value)
        {
            Write(value);
            Write('\n');
        }
    }
}
