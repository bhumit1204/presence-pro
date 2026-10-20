package com.bhumit12.presenceprorn;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.ParcelUuid;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.util.UUID;

public class BleAdvertiserModule extends ReactContextBaseJavaModule {

    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback     advertiseCallback;
    private boolean               isAdvertising = false;

    public BleAdvertiserModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "BleAdvertiser";
    }

    @ReactMethod
    public void startAdvertising(String serviceUUID, Promise promise) {
        if (isAdvertising) {
            promise.resolve("already_advertising");
            return;
        }
        try {
            BluetoothManager manager =
                (BluetoothManager) getReactApplicationContext()
                    .getSystemService(Context.BLUETOOTH_SERVICE);
            if (manager == null) {
                promise.reject("BLE_ERROR", "BluetoothManager unavailable");
                return;
            }
            BluetoothAdapter adapter = manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                promise.reject("BLE_ERROR", "Bluetooth is not enabled");
                return;
            }
            advertiser = adapter.getBluetoothLeAdvertiser();
            if (advertiser == null) {
                promise.reject("BLE_ERROR", "Device does not support BLE advertising");
                return;
            }
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(false)
                .build();
            AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(UUID.fromString(serviceUUID)))
                .addManufacturerData(0x0102, new byte[]{0x01, 0x02})
                .setIncludeDeviceName(false)
                .build();
            advertiseCallback = new AdvertiseCallback() {
                @Override
                public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                    isAdvertising = true;
                    promise.resolve("started");
                }
                @Override
                public void onStartFailure(int errorCode) {
                    isAdvertising = false;
                    promise.reject("BLE_ADV_ERROR", "Advertising failed, errorCode=" + errorCode);
                }
            };
            advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (Exception e) {
            promise.reject("BLE_ERROR", e.getMessage());
        }
    }

    /**
     * Rotating-token beacon.  Same service UUID as before + manufacturer data {0x01,0x02,t0,t1,t2,t3}
     * (28 bytes in total, fits the 31 byte advertising packet).
     * Call it for the first start AND every time the token changes: the previous advertisement is
     * stopped first, so only one beacon is ever on air.
     */
    @ReactMethod
    public void advertiseWithToken(String serviceUUID, String tokenHex, final Promise promise) {
        try {
            if (tokenHex == null || tokenHex.length() != 8) {
                promise.reject("BLE_ERROR", "token must be 8 hex characters");
                return;
            }
            byte[] tok = new byte[4];
            for (int i = 0; i < 4; i++) {
                tok[i] = (byte) Integer.parseInt(tokenHex.substring(i * 2, i * 2 + 2), 16);
            }
            BluetoothManager manager =
                (BluetoothManager) getReactApplicationContext()
                    .getSystemService(Context.BLUETOOTH_SERVICE);
            if (manager == null) {
                promise.reject("BLE_ERROR", "BluetoothManager unavailable");
                return;
            }
            BluetoothAdapter adapter = manager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                promise.reject("BLE_ERROR", "Bluetooth is not enabled");
                return;
            }
            BluetoothLeAdvertiser adv = adapter.getBluetoothLeAdvertiser();
            if (adv == null) {
                promise.reject("BLE_ERROR", "Device does not support BLE advertising");
                return;
            }

            // stop whatever is on air right now (plain beacon or previous token)
            if (advertiser != null && advertiseCallback != null) {
                try { advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
            }
            advertiser        = adv;
            advertiseCallback = null;
            isAdvertising     = false;

            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(false)
                .build();
            AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(UUID.fromString(serviceUUID)))
                .addManufacturerData(0x0102, new byte[]{0x01, 0x02, tok[0], tok[1], tok[2], tok[3]})
                .setIncludeDeviceName(false)
                .build();
            AdvertiseCallback cb = new AdvertiseCallback() {
                @Override
                public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                    isAdvertising = true;
                    promise.resolve("started");
                }
                @Override
                public void onStartFailure(int errorCode) {
                    isAdvertising = false;
                    promise.reject("BLE_ADV_ERROR", "Advertising failed, errorCode=" + errorCode);
                }
            };
            advertiseCallback = cb;
            adv.startAdvertising(settings, data, cb);
        } catch (Exception e) {
            promise.reject("BLE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void stopAdvertising(Promise promise) {
        if (!isAdvertising || advertiser == null || advertiseCallback == null) {
            promise.resolve("not_advertising");
            return;
        }
        try {
            advertiser.stopAdvertising(advertiseCallback);
            isAdvertising     = false;
            advertiseCallback = null;
            promise.resolve("stopped");
        } catch (Exception e) {
            promise.reject("BLE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void isAdvertising(Promise promise) {
        promise.resolve(isAdvertising);
    }
}