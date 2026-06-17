using System.ComponentModel;
using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// SDDL 文字列を self-relative SECURITY_DESCRIPTOR の binary 表現 (byte[]) に
/// 変換するための薄い helper。
/// </summary>
/// <remarks>
/// 用途: WinFsp の GetSecurityByName / GetSecurity callback は self-relative SD
/// を <c>byte[]</c> で要求する。生成は一度きりで済むので caller 側で static cache
/// に置く想定 (本 helper 自体は cache を持たない)。
///
/// <para>P/Invoke は <c>advapi32!ConvertStringSecurityDescriptorToSecurityDescriptorW</c>
/// と <c>kernel32!LocalFree</c>。前者は LocalAlloc されたバッファへのポインタを
/// 返すので、Marshal.Copy で managed byte[] に複製した直後に LocalFree で
/// 解放する。AOT-ready (LibraryImport, no reflection)。</para>
///
/// <para>SDDL リファレンス: <c>O:<i>owner</i>G:<i>group</i>D:<i>dacl</i>S:<i>sacl</i></c>。
/// 典型 (BUILTIN\Administrators owner, DACL で SYSTEM/Admins/Everyone に Full Access):
/// <c>O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)</c>。</para>
/// </remarks>
internal static partial class Sddl
{
    /// <summary>SDDL リビジョン 1 (現行で唯一定義されている値)。</summary>
    private const uint Sddl_Revision_1 = 1;

    [LibraryImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string stringSecurityDescriptor,
        uint stringSDRevision,
        out nint ppSecurityDescriptor,
        out uint pSecurityDescriptorSize);

    [LibraryImport("kernel32.dll", EntryPoint = "LocalFree")]
    private static partial nint LocalFree(nint hMem);

    /// <summary>
    /// SDDL 文字列を self-relative SECURITY_DESCRIPTOR の byte[] に変換する。
    /// </summary>
    /// <exception cref="Win32Exception">SDDL parse 失敗時 (GetLastError 付き)。</exception>
    public static byte[] FromString(string sddl)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, Sddl_Revision_1, out var pSd, out var size))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                $"ConvertStringSecurityDescriptorToSecurityDescriptorW failed for SDDL '{sddl}'");
        }
        try
        {
            var bytes = new byte[size];
            Marshal.Copy(pSd, bytes, 0, (int)size);
            return bytes;
        }
        finally
        {
            // ConvertStringSecurityDescriptorToSecurityDescriptorW は LocalAlloc
            // で確保するので必ず LocalFree する。
            LocalFree(pSd);
        }
    }
}
