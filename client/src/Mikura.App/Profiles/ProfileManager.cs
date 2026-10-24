using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.Versioning;
using Mikura.App.Config;
using Mikura.Core.Identity;

namespace Mikura.App.Profiles;

/// <summary>
/// 全 <see cref="ProfileSession"/> を集約管理する。起動時に
/// <see cref="ProfileStore"/> から全 profile を読み込んで session を spawn し、
/// 終了時に全 session を stop する。enrollment 完了直後の hand-off (runtime add)
/// にも対応 (Phase D で UI が叩く想定)。
/// </summary>
/// <remarks>
/// <para>各 session は独立。1 つが Failed になっても他に伝播させない (try/catch を
/// per-session スコープに閉じる)。Tray UI は <c>Sessions</c> 列を iterate して
/// 状況を表示する。</para>
///
/// <para>Phase B/C 過渡: 単一 profile でも本 manager 経由で動かす。Phase D で
/// UI が複数 profile を扱えるようになる。</para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class ProfileManager : IAsyncDisposable
{
    private readonly ProfileStore _store;
    private readonly string _deviceId;
    private readonly ConcurrentDictionary<string, ProfileSession> _sessions = new();

    public ProfileManager(ProfileStore store, string deviceId)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        if (string.IsNullOrEmpty(deviceId))
            throw new ArgumentException("deviceId required", nameof(deviceId));
        _deviceId = deviceId;
    }

    /// <summary>全 session を name 順で列挙する snapshot。UI iteration 用。</summary>
    public IReadOnlyCollection<ProfileSession> Sessions =>
        _sessions.Values.OrderBy(s => s.Profile.Name).ToList();

    /// <summary>profile name で session を引く。無ければ null。</summary>
    public ProfileSession? TryGet(string profileName) =>
        _sessions.TryGetValue(profileName, out var s) ? s : null;

    /// <summary>
    /// ProfileStore の全 profile を読んで session を spawn し、各々 Start する。
    /// 部分失敗は許容 (= 1 つが Failed でも他は走る)。<paramref name="onSessionAdded"/>
    /// は new session ごとに 1 回ずつ呼ばれる (= UI が menu item を生やす hook)。
    /// </summary>
    public async Task LoadAndStartAllAsync(
        Action<ProfileSession>? onSessionAdded = null,
        CancellationToken ct = default)
    {
        foreach (var profile in _store.LoadProfiles())
        {
            if (ct.IsCancellationRequested) break;
            await StartProfileInternalAsync(profile, onSessionAdded, ct)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Enrollment 完了直後の runtime hand-off。<paramref name="profile"/> + token を
    /// ProfileStore に保存してから session を立ち上げる。失敗時は store の partial
    /// state を残さない (= secret.bin 書込み後の Start 失敗でも、ユーザは再起動で
    /// 通常経路に乗れる)。
    /// </summary>
    public async Task<ProfileSession?> AddAndStartAsync(
        Profile profile,
        string token,
        Action<ProfileSession>? onSessionAdded = null,
        CancellationToken ct = default)
    {
        try
        {
            _store.SaveProfile(profile);
            _store.SaveSecret(profile.Name, token);
        }
        catch (Exception ex)
        {
            Trace.WriteLine(
                $"[ProfileManager] persist failed for {profile.Name}: {ex.Message}");
            return null;
        }
        return await StartProfileInternalAsync(profile, onSessionAdded, ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// 指定 profile の session を止めて、ProfileStore からも削除する。
    /// 既に session が無い場合 (= 何らかの reason で起動失敗していた) は
    /// store だけ削除する。
    /// </summary>
    public async Task RemoveAsync(string profileName)
    {
        if (_sessions.TryRemove(profileName, out var session))
        {
            try
            {
                await session.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Trace.WriteLine(
                    $"[ProfileManager] dispose failed for {profileName}: {ex.Message}");
            }
        }
        try
        {
            _store.RemoveProfile(profileName);
        }
        catch (Exception ex)
        {
            Trace.WriteLine(
                $"[ProfileManager] store remove failed for {profileName}: {ex.Message}");
        }
    }

    /// <summary>指定 profile の session を停止 → 再起動。設定変更後の reapply 用。</summary>
    public async Task RestartAsync(string profileName, CancellationToken ct = default)
    {
        if (!_sessions.TryGetValue(profileName, out var session)) return;
        await session.RestartAsync(ct).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var s in _sessions.Values.ToList())
        {
            try { await s.DisposeAsync(); }
            catch { /* best-effort */ }
        }
        _sessions.Clear();
    }

    private async Task<ProfileSession?> StartProfileInternalAsync(
        Profile profile,
        Action<ProfileSession>? onSessionAdded,
        CancellationToken ct)
    {
        // secret.bin を Unprotect。失敗時は profile 自体を skip + Trace log
        // (= 他 profile を巻き込まない)。
        string? token;
        try
        {
            token = _store.LoadSecret(profile.Name);
        }
        catch (Exception ex)
        {
            Trace.WriteLine(
                $"[ProfileManager] secret decrypt failed for {profile.Name}: {ex.Message}");
            return null;
        }
        if (string.IsNullOrEmpty(token))
        {
            Trace.WriteLine(
                $"[ProfileManager] secret.bin missing for {profile.Name}, skipping");
            return null;
        }

        var session = new ProfileSession(profile, token, _deviceId);
        if (!_sessions.TryAdd(profile.Name, session))
        {
            Trace.WriteLine(
                $"[ProfileManager] duplicate profile name {profile.Name}, skipping");
            return null;
        }
        onSessionAdded?.Invoke(session);
        // session.StartAsync は内部で catch → Failed status。本 manager の
        // 観点では「start 試行を投げた」段階で OK。
        await session.StartAsync(ct).ConfigureAwait(false);
        return session;
    }

    /// <summary>
    /// 最も若い (= 最初に enroll された) profile を返す。Phase B 過渡 (= 単一 profile
    /// 想定の old call site) で使う、Phase D の UI 化で不要に。
    /// </summary>
    public ProfileSession? FirstOrDefault() =>
        _sessions.Values.OrderBy(s => s.Profile.EnrolledAt).FirstOrDefault();
}
