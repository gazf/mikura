using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Mikura.Core.Sync;

/// <summary>
/// shell32!SHChangeNotify の薄いラッパー。
/// CfCreatePlaceholders / File.Delete だけでは Explorer のビューが自動更新されない (F5 が必要) ため、
/// プレースホルダー作成・削除・更新後にこの通知を発火して Explorer に再描画させる。
/// </summary>
internal static partial class Shell
{
    // SHChangeNotify event IDs
    private const int SHCNE_CREATE = 0x00000002;
    private const int SHCNE_DELETE = 0x00000004;
    private const int SHCNE_MKDIR = 0x00000008;
    private const int SHCNE_RMDIR = 0x00000010;
    private const int SHCNE_UPDATEDIR = 0x00001000;
    private const int SHCNE_UPDATEITEM = 0x00002000;

    // SHChangeNotify flags
    private const uint SHCNF_PATHW = 0x0005;

    [LibraryImport("shell32.dll", EntryPoint = "SHChangeNotify", StringMarshalling = StringMarshalling.Utf16)]
    private static partial void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);

    public static void NotifyCreate(string localPath, bool isDirectory)
    {
        SHChangeNotify(isDirectory ? SHCNE_MKDIR : SHCNE_CREATE, SHCNF_PATHW, localPath, IntPtr.Zero);
        Trace.WriteLine($"Shell.NotifyCreate ({(isDirectory ? "MKDIR" : "CREATE")}): {localPath}");
    }

    public static void NotifyDelete(string localPath, bool isDirectory)
    {
        SHChangeNotify(isDirectory ? SHCNE_RMDIR : SHCNE_DELETE, SHCNF_PATHW, localPath, IntPtr.Zero);
        Trace.WriteLine($"Shell.NotifyDelete ({(isDirectory ? "RMDIR" : "DELETE")}): {localPath}");
    }

    public static void NotifyUpdate(string localPath)
    {
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, localPath, IntPtr.Zero);
        Trace.WriteLine($"Shell.NotifyUpdate: {localPath}");
    }

    /// <summary>
    /// ディレクトリの再列挙を Explorer に促す。複数ファイルを一括追加した後など
    /// 1 件ずつ NotifyCreate するより効率的。
    /// </summary>
    public static void NotifyUpdateDir(string localDirectoryPath)
    {
        SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW, localDirectoryPath, IntPtr.Zero);
        Trace.WriteLine($"Shell.NotifyUpdateDir: {localDirectoryPath}");
    }
}
