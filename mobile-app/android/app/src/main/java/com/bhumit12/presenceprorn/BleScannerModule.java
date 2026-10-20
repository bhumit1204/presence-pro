package com.bhumit12.presenceprorn;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

public class BleScannerModule extends ReactContextBaseJavaModule {

    private BluetoothLeScanner scanner;
    private ScanCallback        activeScanCallback;
    private boolean             isScanning = false;

    private static final String TARGET_UUID = "12345678-1234-1234-1234-123456789abc";
    private static final byte   MFR_BYTE_0  = 0x01;
    private static final byte   MFR_BYTE_1  = 0x02;

    public BleScannerModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "BleScanner";
    }

    @ReactMethod
    public void scanForTeacher(int durationMs, Promise promise) {
        if (isScanning) {
            promise.reject("SCAN_ERROR", "A scan is already running");
            return;
        }
        try {
            BluetoothManager btManager =
                (BluetoothManager) getReactApplicationContext()
                    .getSystemService(Context.BLUETOOTH_SERVICE);
            if (btManager == null) { promise.resolve(null); return; }
            BluetoothAdapter adapter = btManager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) { promise.resolve(null); return; }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) { promise.resolve(null); return; }

            final int[]     bestRssi = { Integer.MIN_VALUE };
            final boolean[] found    = { false };

            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

            activeScanCallback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    if (isTeacherBeacon(result)) {
                        int rssi = result.getRssi();
                        if (rssi > bestRssi[0]) { bestRssi[0] = rssi; found[0] = true; }
                    }
                }
                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    for (ScanResult r : results) {
                        if (isTeacherBeacon(r)) {
                            int rssi = r.getRssi();
                            if (rssi > bestRssi[0]) { bestRssi[0] = rssi; found[0] = true; }
                        }
                    }
                }
                @Override
                public void onScanFailed(int errorCode) {
                    isScanning = false;
                    promise.reject("SCAN_FAILED", "BLE scan failed, errorCode=" + errorCode);
                }
            };

            isScanning = true;
            scanner.startScan(null, settings, activeScanCallback);

            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (isScanning && scanner != null && activeScanCallback != null)
                        scanner.stopScan(activeScanCallback);
                } catch (Exception ignored) {}
                isScanning         = false;
                activeScanCallback = null;
                if (found[0]) promise.resolve(bestRssi[0]);
                else          promise.resolve(null);
            }, durationMs);

        } catch (Exception e) {
            isScanning = false;
            promise.reject("SCAN_ERROR", e.getMessage());
        }
    }

    /**
     * Detailed scan: every sample of the teacher beacon is kept.
     * Resolves { best, median, count, tokens:[hex...] }  or null when no beacon was heard.
     * (scanForTeacher above is unchanged and still works.)
     */
    @ReactMethod
    public void scanForTeacherDetailed(int durationMs, final Promise promise) {
        if (isScanning) {
            promise.reject("SCAN_ERROR", "A scan is already running");
            return;
        }
        try {
            BluetoothManager btManager =
                (BluetoothManager) getReactApplicationContext()
                    .getSystemService(Context.BLUETOOTH_SERVICE);
            if (btManager == null) { promise.resolve(null); return; }
            BluetoothAdapter adapter = btManager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) { promise.resolve(null); return; }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) { promise.resolve(null); return; }

            final List<Integer> samples = Collections.synchronizedList(new ArrayList<Integer>());
            final Set<String>   tokens  = Collections.synchronizedSet(new LinkedHashSet<String>());

            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

            activeScanCallback = new ScanCallback() {
                private void take(ScanResult r) {
                    if (!isTeacherBeacon(r)) return;
                    samples.add(r.getRssi());
                    String t = extractToken(r);
                    if (t != null) tokens.add(t);
                }
                @Override
                public void onScanResult(int callbackType, ScanResult result) { take(result); }
                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    for (ScanResult r : results) take(r);
                }
                @Override
                public void onScanFailed(int errorCode) {
                    isScanning = false;
                    promise.reject("SCAN_FAILED", "BLE scan failed, errorCode=" + errorCode);
                }
            };

            isScanning = true;
            scanner.startScan(null, settings, activeScanCallback);

            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (isScanning && scanner != null && activeScanCallback != null)
                        scanner.stopScan(activeScanCallback);
                } catch (Exception ignored) {}
                isScanning         = false;
                activeScanCallback = null;

                List<Integer> copy;
                synchronized (samples) { copy = new ArrayList<Integer>(samples); }
                if (copy.isEmpty()) { promise.resolve(null); return; }

                Collections.sort(copy);
                int n    = copy.size();
                double med = (n % 2 == 1) ? copy.get(n / 2) : (copy.get(n / 2 - 1) + copy.get(n / 2)) / 2.0;

                WritableMap out = Arguments.createMap();
                out.putInt("best", copy.get(n - 1));
                out.putDouble("median", med);
                out.putInt("count", n);
                WritableArray arr = Arguments.createArray();
                synchronized (tokens) { for (String t : tokens) arr.pushString(t); }
                out.putArray("tokens", arr);
                promise.resolve(out);
            }, durationMs);

        } catch (Exception e) {
            isScanning = false;
            promise.reject("SCAN_ERROR", e.getMessage());
        }
    }

    /** token = bytes 2..5 of our manufacturer data, as 8 hex chars (null for the old token-less beacon) */
    private String extractToken(ScanResult result) {
        if (result == null || result.getScanRecord() == null) return null;
        android.util.SparseArray<byte[]> mfrData = result.getScanRecord().getManufacturerSpecificData();
        if (mfrData == null) return null;
        for (int i = 0; i < mfrData.size(); i++) {
            byte[] d = mfrData.valueAt(i);
            if (d != null && d.length >= 6 && d[0] == MFR_BYTE_0 && d[1] == MFR_BYTE_1) {
                StringBuilder sb = new StringBuilder(8);
                for (int k = 2; k < 6; k++) sb.append(String.format("%02x", d[k] & 0xff));
                return sb.toString();
            }
        }
        return null;
    }

    private boolean isTeacherBeacon(ScanResult result) {
        if (result == null || result.getScanRecord() == null) return false;
        android.bluetooth.le.ScanRecord record = result.getScanRecord();
        List<ParcelUuid> uuids = record.getServiceUuids();
        if (uuids != null)
            for (ParcelUuid p : uuids)
                if (p.getUuid().equals(UUID.fromString(TARGET_UUID))) return true;
        android.util.SparseArray<byte[]> mfrData = record.getManufacturerSpecificData();
        if (mfrData != null)
            for (int i = 0; i < mfrData.size(); i++) {
                byte[] data = mfrData.valueAt(i);
                if (data != null && data.length >= 2 && data[0] == MFR_BYTE_0 && data[1] == MFR_BYTE_1)
                    return true;
            }
        return false;
    }
}