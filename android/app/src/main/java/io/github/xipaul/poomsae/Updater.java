package io.github.xipaul.poomsae;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * APK 자동 업데이트.
 * 1) GitHub Releases에서 apk-1.0.N 태그를 찾아 N(= 빌드 번호 = versionCode)을 현재 버전과 비교
 * 2) 새 버전이면 묻고 → APK를 받아 PackageInstaller 세션에 기록 → 안드로이드 설치 확인 창
 * 설치 결과는 MainActivity(singleTask)의 onNewIntent로 돌아온다 (Android 공식 샘플 방식).
 */
class Updater {
    static final String ACTION_RESULT = BuildConfig.APPLICATION_ID + ".INSTALL_RESULT";
    private static final Pattern TAG = Pattern.compile("^apk-\\d+\\.\\d+\\.(\\d+)$");
    private static final long CHECK_INTERVAL_MS = 60L * 60L * 1000L; // 자동 확인은 1시간에 한 번

    private final Activity act;
    private final SharedPreferences sp;
    private volatile boolean busy;
    private String pendingUrl;      // "알 수 없는 앱 설치" 허용하러 간 사이 기억
    private String pendingVersion;

    Updater(Activity act) {
        this.act = act;
        this.sp = act.getSharedPreferences("updater", Context.MODE_PRIVATE);
    }

    private void toast(String s) {
        act.runOnUiThread(() -> Toast.makeText(act, s, Toast.LENGTH_LONG).show());
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "poomsae-app/" + BuildConfig.VERSION_NAME);
        return c;
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = open(url);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("GitHub 응답 " + code);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    /** manual=true: 설정 화면 버튼 — 간격 무시, "최신 버전" 안내도 표시 */
    void check(boolean manual) {
        if (busy) return;
        long now = System.currentTimeMillis();
        if (!manual && now - sp.getLong("lastCheck", 0) < CHECK_INTERVAL_MS) return;
        busy = true;
        new Thread(() -> {
            try {
                JSONArray rels = new JSONArray(get("https://api.github.com/repos/" + BuildConfig.GH_REPO + "/releases?per_page=20"));
                sp.edit().putLong("lastCheck", now).apply();
                int best = -1;
                String bestUrl = null;
                for (int i = 0; i < rels.length(); i++) {
                    JSONObject r = rels.getJSONObject(i);
                    if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue;
                    Matcher m = TAG.matcher(r.optString("tag_name"));
                    if (!m.find()) continue;
                    int code = Integer.parseInt(m.group(1));
                    JSONArray assets = r.optJSONArray("assets");
                    if (assets == null) continue;
                    for (int j = 0; j < assets.length(); j++) {
                        JSONObject a = assets.getJSONObject(j);
                        if (a.optString("name").endsWith(".apk") && code > best) {
                            best = code;
                            bestUrl = a.optString("browser_download_url");
                        }
                    }
                }
                final int cur = BuildConfig.VERSION_CODE;
                if (best > cur && bestUrl != null) {
                    final String url = bestUrl, ver = "1.0." + best;
                    act.runOnUiThread(() -> ask(ver, url));
                } else if (manual) {
                    toast("최신 버전이에요 (" + BuildConfig.VERSION_NAME + ")");
                }
            } catch (Exception e) {
                if (manual) toast("업데이트 확인 실패: " + e.getMessage());
            } finally {
                busy = false;
            }
        }).start();
    }

    private void ask(String ver, String url) {
        if (act.isFinishing()) return;
        new AlertDialog.Builder(act)
                .setTitle("새 버전이 있어요")
                .setMessage("품새 연습장 " + ver + "로 업데이트할까요?\n(지금 " + BuildConfig.VERSION_NAME + ", 기록과 영상은 그대로 유지돼요)")
                .setPositiveButton("업데이트", (d, w) -> start(ver, url))
                .setNegativeButton("나중에", null)
                .show();
    }

    private void start(String ver, String url) {
        if (!act.getPackageManager().canRequestPackageInstalls()) {
            pendingUrl = url;
            pendingVersion = ver;
            toast("'이 출처 허용'을 켜고 뒤로 돌아오면 이어서 설치해요");
            act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + act.getPackageName())));
            return;
        }
        download(ver, url);
    }

    /** MainActivity.onResume — 설치 허용 화면에서 돌아왔을 때 이어서 진행 */
    void resume() {
        if (pendingUrl != null && act.getPackageManager().canRequestPackageInstalls()) {
            String url = pendingUrl, ver = pendingVersion;
            pendingUrl = null;
            pendingVersion = null;
            download(ver, url);
        } else {
            check(false);
        }
    }

    private void download(String ver, String url) {
        final AlertDialog dlg = new AlertDialog.Builder(act)
                .setTitle(ver + " 받는 중")
                .setMessage("0%")
                .setCancelable(false)
                .show();
        new Thread(() -> {
            PackageInstaller pi = act.getPackageManager().getPackageInstaller();
            int sid = -1;
            try {
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(
                        PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(act.getPackageName());
                sid = pi.createSession(p);
                try (PackageInstaller.Session s = pi.openSession(sid)) {
                    HttpURLConnection c = open(url);
                    int rc = c.getResponseCode();
                    if (rc != 200) throw new IOException("다운로드 응답 " + rc);
                    long total = c.getContentLengthLong();
                    try (InputStream in = c.getInputStream();
                         OutputStream out = s.openWrite("app.apk", 0, total > 0 ? total : -1)) {
                        byte[] buf = new byte[65536];
                        long done = 0;
                        int n, lastPct = -1;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            done += n;
                            if (total > 0) {
                                int pct = (int) (done * 100 / total);
                                if (pct != lastPct) {
                                    lastPct = pct;
                                    act.runOnUiThread(() -> dlg.setMessage(pct + "%"));
                                }
                            }
                        }
                        s.fsync(out);
                    } finally {
                        c.disconnect();
                    }
                    Intent result = new Intent(act, MainActivity.class).setAction(ACTION_RESULT);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT
                            | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent cb = PendingIntent.getActivity(act, sid, result, flags);
                    s.commit(cb.getIntentSender());
                }
                act.runOnUiThread(dlg::dismiss);
            } catch (Exception e) {
                if (sid >= 0) {
                    try {
                        pi.abandonSession(sid);
                    } catch (Exception ignored) {
                    }
                }
                act.runOnUiThread(dlg::dismiss);
                toast("업데이트 실패: " + e.getMessage());
            }
        }).start();
    }

    /** MainActivity.onNewIntent — 설치 진행 상태 */
    @SuppressWarnings("deprecation")
    boolean onResult(Intent i) {
        if (i == null || !ACTION_RESULT.equals(i.getAction())) return false;
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? i.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) act.startActivity(confirm);
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            toast("설치하지 못했어요" + (msg != null ? ": " + msg : ""));
        }
        return true;
    }
}
