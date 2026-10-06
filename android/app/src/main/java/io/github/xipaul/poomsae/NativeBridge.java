package io.github.xipaul.poomsae;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 웹앱(window.TkdNative)에서 부르는 저장 기능.
 * 영상:   Movies/품새연습장/{아이}/{품새}/파일.mp4      — 갤러리에 보임
 * 관절:   Documents/품새연습장/{아이}/{품새}/파일.pose.json — 파일 관리자에 보임
 * Android 10+ MediaStore를 쓰므로 저장소 권한이 필요 없다 (이 앱이 만든 파일만 읽고 지움).
 */
public class NativeBridge {
    private static final String ROOT = "품새연습장";

    private final Activity act;
    private final Updater updater;
    private final ContentResolver cr;
    private final Map<Integer, OutputStream> outs = new HashMap<>();
    private final Map<Integer, Uri> outUris = new HashMap<>();
    private final Map<Integer, InputStream> ins = new HashMap<>();
    private int nextId = 1;

    NativeBridge(Activity act, Updater updater) {
        this.act = act;
        this.updater = updater;
        this.cr = act.getContentResolver();
    }

    // ---- 경로 ----
    private static String cleanSub(String sub) {
        if (sub == null || sub.contains("..") || !sub.matches("[A-Za-z0-9_\\-/]+")) {
            throw new IllegalArgumentException("잘못된 폴더 이름: " + sub);
        }
        return sub.replaceAll("^/+|/+$", "");
    }

    private static String cleanName(String name) {
        if (name == null || name.contains("/") || name.contains("..") || name.isEmpty()) {
            throw new IllegalArgumentException("잘못된 파일 이름: " + name);
        }
        return name;
    }

    private static String videoDir(String sub) {
        return Environment.DIRECTORY_MOVIES + "/" + ROOT + "/" + cleanSub(sub) + "/";
    }

    private static String docDir(String sub) {
        return Environment.DIRECTORY_DOCUMENTS + "/" + ROOT + "/" + cleanSub(sub) + "/";
    }

    private static Uri videoCollection() {
        return MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private static Uri fileCollection() {
        return MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private static Uri checkUri(String s) {
        Uri u = Uri.parse(s);
        if (!"content".equals(u.getScheme()) || !"media".equals(u.getAuthority())) {
            throw new IllegalArgumentException("허용되지 않은 주소");
        }
        return u;
    }

    private Uri findOne(Uri collection, String relPath, String name) {
        String[] proj = {MediaStore.MediaColumns._ID};
        String sel = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?";
        try (Cursor c = cr.query(collection, proj, sel, new String[]{relPath, name}, null)) {
            if (c != null && c.moveToFirst()) return ContentUris.withAppendedId(collection, c.getLong(0));
        }
        return null;
    }

    // ---- 정보 ----
    @JavascriptInterface
    public String version() {
        return BuildConfig.VERSION_NAME;
    }

    /** 설정 화면 "업데이트 확인" */
    @JavascriptInterface
    public void checkUpdate() {
        updater.check(true);
    }

    @JavascriptInterface
    public String folderLabel() {
        return Environment.DIRECTORY_MOVIES + "/" + ROOT;
    }

    // ---- 영상 쓰기: begin → chunk(base64)… → end ----
    @JavascriptInterface
    public synchronized int beginVideo(String sub, String name, String mime) throws IOException {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName(name));
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, videoDir(sub));
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(videoCollection(), v);
        if (uri == null) throw new IOException("영상 파일을 만들 수 없어요");
        OutputStream os = cr.openOutputStream(uri, "w");
        if (os == null) {
            cr.delete(uri, null, null);
            throw new IOException("영상 파일을 열 수 없어요");
        }
        int id = nextId++;
        outs.put(id, os);
        outUris.put(id, uri);
        return id;
    }

    @JavascriptInterface
    public synchronized boolean writeChunk(int id, String b64) throws IOException {
        OutputStream os = outs.get(id);
        if (os == null) throw new IOException("저장이 시작되지 않았어요");
        os.write(Base64.decode(b64, Base64.DEFAULT));
        return true;
    }

    @JavascriptInterface
    public synchronized String endVideo(int id) throws IOException {
        OutputStream os = outs.remove(id);
        Uri uri = outUris.remove(id);
        if (os == null || uri == null) throw new IOException("저장이 시작되지 않았어요");
        os.close();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return uri.toString();
    }

    @JavascriptInterface
    public synchronized void abortVideo(int id) {
        OutputStream os = outs.remove(id);
        Uri uri = outUris.remove(id);
        try {
            if (os != null) os.close();
        } catch (IOException ignored) {
        }
        if (uri != null) cr.delete(uri, null, null);
    }

    // ---- 관절 데이터(JSON) ----
    @JavascriptInterface
    public synchronized String writeText(String sub, String name, String text) throws IOException {
        String rel = docDir(sub);
        Uri uri = findOne(fileCollection(), rel, cleanName(name));
        if (uri == null) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            uri = cr.insert(fileCollection(), v);
            if (uri == null) throw new IOException("관절 데이터 파일을 만들 수 없어요");
        }
        try (OutputStream os = cr.openOutputStream(uri, "wt")) {
            if (os == null) throw new IOException("관절 데이터 파일을 열 수 없어요");
            os.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return uri.toString();
    }

    /** → [{"name":"..pose.json","uri":"content://media/..."}] */
    @JavascriptInterface
    public synchronized String listJson(String sub) throws Exception {
        JSONArray out = new JSONArray();
        String[] proj = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME};
        String sel = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        try (Cursor c = cr.query(fileCollection(), proj, sel, new String[]{docDir(sub), "%.pose.json"}, null)) {
            while (c != null && c.moveToNext()) {
                JSONObject o = new JSONObject();
                o.put("name", c.getString(1));
                o.put("uri", ContentUris.withAppendedId(fileCollection(), c.getLong(0)).toString());
                out.put(o);
            }
        }
        return out.toString();
    }

    @JavascriptInterface
    public synchronized String readText(String uri) throws IOException {
        try (InputStream is = cr.openInputStream(checkUri(uri))) {
            if (is == null) throw new IOException("파일을 열 수 없어요");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        }
    }

    // ---- 영상 읽기: find → open → chunk… → close ----
    @JavascriptInterface
    public synchronized String findVideo(String sub, String name) {
        Uri u = findOne(videoCollection(), videoDir(sub), cleanName(name));
        return u == null ? "" : u.toString();
    }

    @JavascriptInterface
    public synchronized int openRead(String uri) throws IOException {
        InputStream is = cr.openInputStream(checkUri(uri));
        if (is == null) throw new IOException("영상 파일을 열 수 없어요");
        int id = nextId++;
        ins.put(id, is);
        return id;
    }

    /** base64 조각, 끝이면 "" */
    @JavascriptInterface
    public synchronized String readChunk(int id, int maxBytes) throws IOException {
        InputStream is = ins.get(id);
        if (is == null) throw new IOException("읽기가 시작되지 않았어요");
        byte[] buf = new byte[Math.max(1024, Math.min(maxBytes, 4 * 1024 * 1024))];
        int total = 0;
        while (total < buf.length) {
            int n = is.read(buf, total, buf.length - total);
            if (n < 0) break;
            total += n;
        }
        return total == 0 ? "" : Base64.encodeToString(buf, 0, total, Base64.NO_WRAP);
    }

    @JavascriptInterface
    public synchronized void closeRead(int id) {
        InputStream is = ins.remove(id);
        try {
            if (is != null) is.close();
        } catch (IOException ignored) {
        }
    }

    // ---- 삭제 / 공유 / 화면 ----
    @JavascriptInterface
    public synchronized boolean remove(String uri) {
        return cr.delete(checkUri(uri), null, null) > 0;
    }

    @JavascriptInterface
    public void share(String uri, String mime, String title) {
        final Uri u = checkUri(uri);
        act.runOnUiThread(() -> {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, u);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(Intent.createChooser(send, title));
        });
    }

    /** 촬영 모드: 가로 고정 + 상태바·내비게이션바 숨김 + 화면 켜짐 */
    @SuppressWarnings("deprecation")
    @JavascriptInterface
    public void shootMode(boolean on) {
        act.runOnUiThread(() -> {
            act.setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            Window w = act.getWindow();
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    if (on) {
                        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        c.hide(WindowInsets.Type.systemBars());
                    } else {
                        c.show(WindowInsets.Type.systemBars());
                    }
                }
            } else {
                View d = w.getDecorView();
                int f = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                int cur = d.getSystemUiVisibility();
                d.setSystemUiVisibility(on ? (cur | f) : (cur & ~f));
            }
            if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @JavascriptInterface
    public void keepScreenOn(boolean on) {
        act.runOnUiThread(() -> {
            if (on) act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }
}
