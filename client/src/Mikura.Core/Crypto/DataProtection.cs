using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Mikura.Core.Crypto;

/// <summary>
/// Windows DPAPI (Data Protection API) の薄い P/Invoke wrapper。
/// 用途: bearer token を at-rest 保存する時の暗号化。CurrentUser scope で、
/// 同 Windows account の同 machine 上でのみ復号できる。別 PC へ file ごと
/// コピーしても復号不可能 = file leak に対する基本防御。
/// </summary>
/// <remarks>
/// <para><b>scope</b>: <c>CurrentUser</c> 固定。同マシン内の別 Windows user は
/// 復号不可、別マシンは当然不可。LocalMachine scope は同マシン内の任意 process
/// が読めるので mikura では不採用。</para>
///
/// <para><b>同梱 entropy 無し</b>: optionalEntropy は使わない (アプリ側で
/// secret を抱える必要が出ないように)。entropy が無くても CurrentUser scope は
/// それ自体が key separator として機能する。</para>
///
/// <para><b>AOT-ready</b>: LibraryImport (source-generator) + 単純 byte[] marshaling
/// のみで reflection 不使用。<c>WinFsp.Native.SecurityDescriptors</c> と同じ流儀。</para>
///
/// <para><b>cross-platform 注意</b>: Linux で本クラスを **呼ぶ** とランタイムで
/// DllNotFoundException (crypt32.dll なし) が出る。compile 自体は通る。Mikura.Core
/// は multi-target (net10.0 + net10.0-windows) で、Linux 経路 (bench harness 等) は
/// 本 API を呼ばない設計を維持すること。</para>
/// </remarks>
public static partial class DataProtection
{
    // DPAPI flag。CRYPTPROTECT_UI_FORBIDDEN: prompt UI を一切出さない (= 非対話
    // 経路で予期せず blocking ダイアログを出さない安全弁)。tray daemon の起動時に
    // ダイアログが出ると詰む。
    private const uint CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    // DATA_BLOB struct: DPAPI が in/out で使う pointer + length pair。
    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB
    {
        public uint cbData;
        public nint pbData;
    }

    [LibraryImport("crypt32.dll", EntryPoint = "CryptProtectData", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CryptProtectData(
        ref DATA_BLOB dataIn,
        nint szDataDescr,
        nint optionalEntropy,
        nint pvReserved,
        nint pPromptStruct,
        uint dwFlags,
        ref DATA_BLOB dataOut);

    [LibraryImport("crypt32.dll", EntryPoint = "CryptUnprotectData", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CryptUnprotectData(
        ref DATA_BLOB dataIn,
        nint szDataDescr,
        nint optionalEntropy,
        nint pvReserved,
        nint pPromptStruct,
        uint dwFlags,
        ref DATA_BLOB dataOut);

    [LibraryImport("kernel32.dll", EntryPoint = "LocalFree")]
    private static partial nint LocalFree(nint hMem);

    /// <summary>
    /// plaintext を DPAPI(CurrentUser) で暗号化する。空配列も valid な入力。
    /// </summary>
    /// <exception cref="Win32Exception">DPAPI 呼び出し失敗 (GetLastError 付き)。</exception>
    [SupportedOSPlatform("windows")]
    public static byte[] Protect(byte[] plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);

        // 空 buffer でも DPAPI に渡せるよう、ダミー 1 byte を割り当てる
        // (= cbData=0 + pbData=null は受け付けない API がある、安全側)。
        unsafe
        {
            fixed (byte* p = plaintext.Length == 0 ? new byte[1] : plaintext)
            {
                var dataIn = new DATA_BLOB
                {
                    cbData = (uint)plaintext.Length,
                    pbData = (nint)p,
                };
                var dataOut = default(DATA_BLOB);

                if (!CryptProtectData(ref dataIn, 0, 0, 0, 0,
                        CRYPTPROTECT_UI_FORBIDDEN, ref dataOut))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "CryptProtectData failed");
                }

                try
                {
                    var result = new byte[dataOut.cbData];
                    Marshal.Copy(dataOut.pbData, result, 0, (int)dataOut.cbData);
                    return result;
                }
                finally
                {
                    LocalFree(dataOut.pbData);
                }
            }
        }
    }

    /// <summary>
    /// DPAPI(CurrentUser) で暗号化された byte[] を復号する。別 user / 別 machine の
    /// データは Win32Exception (NTE_BAD_KEY_STATE 系) で失敗する。
    /// </summary>
    /// <exception cref="Win32Exception">DPAPI 呼び出し失敗 (scope mismatch / 改変等)。</exception>
    [SupportedOSPlatform("windows")]
    public static byte[] Unprotect(byte[] ciphertext)
    {
        ArgumentNullException.ThrowIfNull(ciphertext);
        if (ciphertext.Length == 0)
            throw new ArgumentException("ciphertext must not be empty", nameof(ciphertext));

        unsafe
        {
            fixed (byte* p = ciphertext)
            {
                var dataIn = new DATA_BLOB
                {
                    cbData = (uint)ciphertext.Length,
                    pbData = (nint)p,
                };
                var dataOut = default(DATA_BLOB);

                if (!CryptUnprotectData(ref dataIn, 0, 0, 0, 0,
                        CRYPTPROTECT_UI_FORBIDDEN, ref dataOut))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(),
                        "CryptUnprotectData failed (different user / machine / corrupted?)");
                }

                try
                {
                    var result = new byte[dataOut.cbData];
                    Marshal.Copy(dataOut.pbData, result, 0, (int)dataOut.cbData);
                    return result;
                }
                finally
                {
                    LocalFree(dataOut.pbData);
                }
            }
        }
    }
}
