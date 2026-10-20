/*
  PresenceMarker.ino  —  v2 (BLE-provisioned, hand-held / wall-mounted)

  What changed vs v1
  ──────────────────
  • No Wi-Fi hotspot / web portal any more. The device boots as a BLE GATT server only.
  • The teacher's phone scans Wi-Fi networks, the teacher picks one, and the phone sends the
    credentials over GATT. The device joins the network, answers WIFI_OK / WIFI_FAIL, saves the
    credentials (NVS), and then drops the teacher's connection and works as the attendance marker.
    On the next boot it re-joins the saved network on its own.
  • Two placement modes, chosen by the teacher for every session:
        HANDHELD  – low TX power, students must be right next to the device (phone gates on RSSI).
        MOUNTED   – maximum TX power + faster advertising; students can mark from their seats.
    The mode and "session active" flag are broadcast in the advertisement (manufacturer data), so
    the student app knows which RSSI rule to use and does not connect when no session is running.
  • Student marks are queued and processed from loop() (never inside the BLE callback), one HTTP
    keep-alive connection is reused, and replies carry a 4-char student tag so several students can
    be connected at the same time without receiving each other's answer.
  • Control commands (Wi-Fi / session / stop) must carry SETUP_KEY. Change it and put the same
    value in IoTAttendanceScreen.tsx. Students never send it, so a student cannot stop a session
    or re-point the device.

  GATT layout (unchanged UUIDs)
  ─────────────────────────────
    Service  6E400001-…
      CONTROL  6E400002-…  (write + notify)  teacher phone  ⇄ device, newline-terminated JSON
      STUDENT  6E400003-…  (write + notify)  student phone  ⇄ device, write = uid, notify = "<tag>|<CODE>[|<sess>]"

  Control commands (teacher → device), each one JSON object + '\n':
    {"c":"wifi","k":KEY,"ssid":"..","pass":".."}              → RX, then WIFI_OK | WIFI_FAIL:auth | WIFI_FAIL:nossid | WIFI_FAIL:timeout
    {"c":"session","k":KEY,"lec":"..","att":"..","api":"http://host:5000","mode":"handheld|mounted"}
                                                              → SESSION_OK | NO_WIFI | SESSION_ERR
    {"c":"stop","k":KEY}                                      → STOPPED
    {"c":"status","k":KEY}                                    → STATUS:{"w":1,"s":"ssid","m":"M","a":0}
    any command with a wrong key                              → AUTH_ERR

  Board: ESP32 Dev Module (arduino-esp32 2.0.x or 3.x). Libraries: ArduinoJson 6.x.
  Partition scheme: "Huge APP" or "No OTA" is recommended (Wi-Fi + BLE together are large).
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <vector>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_bt.h"

// ───────────────────────── configuration ─────────────────────────
#define SETUP_KEY          "pm-setup-2026"     // ← change me (must match the teacher app)
#define DEVICE_NAME        "PresenceMarker"
#define LED_PIN            2

#define SERVICE_UUID       "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CONTROL_CHAR_UUID  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define STUDENT_CHAR_UUID  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

const esp_power_level_t TX_HANDHELD = ESP_PWR_LVL_P3;   // +3 dBm  (same as the old default)
const esp_power_level_t TX_MOUNTED  = ESP_PWR_LVL_P9;   // +9 dBm  (max on classic ESP32)

const uint16_t ADV_INT_HANDHELD = 0x40;   //  40 ms
const uint16_t ADV_INT_MOUNTED  = 0x30;   //  30 ms  (found faster from far away)

const size_t        MAX_QUEUE          = 24;      // pending student marks
const unsigned long QUEUE_STALE_MS     = 15000;   // student already gave up
const size_t        MAX_MARKED_CACHE   = 400;     // uids remembered per session
const unsigned long CONN_MAX_MS        = 40000;   // drop a BLE client that hangs around longer
const int           WIFI_JOIN_TIMEOUT  = 15;      // seconds, when teacher sends credentials

// ───────────────────────── state ─────────────────────────
Preferences prefs;

BLEServer*         bleServer   = nullptr;
BLECharacteristic* controlChar = nullptr;
BLECharacteristic* studentChar = nullptr;
bool               needAdvRefresh = true;
bool               advRunning     = false;

String  savedSsid, savedPass;
bool    mounted = false;                 // current placement mode

// session (RAM only – never stored)
String  lectureSessionId, attendanceSessionId, apiUrl;
bool    sessionActive = false;

// Wi-Fi provisioning request (set in BLE callback, executed in loop)
volatile bool pendingWifi = false;
String  pendSsid, pendPass;

// student queue
struct MarkReq { String uid; unsigned long at; };
std::vector<MarkReq> markQueue;
std::vector<String>  markedCache;
SemaphoreHandle_t    qMutex;

// BLE connection watchdog
struct ConnInfo { uint16_t id; unsigned long at; };
ConnInfo conns[9];
int      ctrlConnId   = -1;          // connection that last wrote on CONTROL (the teacher)
unsigned long teacherDropAt = 0;

// control lines received in the BLE task, executed in loop()
std::vector<String> ctrlLines;
String              ctrlBuf;      // a command may arrive in several chunks; it ends with '\n'

WiFiClient       plainClient;
WiFiClientSecure secureClient;
HTTPClient       http;

String deviceState = "BOOT";
unsigned long lastBlink = 0, lastWifiCheck = 0;

void updateLED();

// ───────────────────────── helpers ─────────────────────────
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
typedef String BleStr;
#else
typedef std::string BleStr;
#endif

// 4-hex-char tag of a uid. Same algorithm in IoTMarkingScreen.tsx (FNV-1a, folded to 16 bits).
String uidTag(const String& s) {
  uint32_t h = 0x811c9dc5u;
  for (size_t i = 0; i < s.length(); i++) { h ^= (uint8_t)s[i]; h *= 0x01000193u; }
  h = (h ^ (h >> 16)) & 0xFFFF;
  char b[5]; snprintf(b, sizeof(b), "%04X", (unsigned)h);
  return String(b);
}

void notifyControl(const String& msg) {
  if (!controlChar) return;
  controlChar->setValue(msg.c_str());
  controlChar->notify();
  Serial.println("[CTRL→] " + msg);
}

void notifyStudent(const String& uid, const char* code, const String& extra = "") {
  if (!studentChar) return;
  String m = uidTag(uid) + "|" + code;
  if (extra.length()) m += "|" + extra;
  studentChar->setValue(m.c_str());
  studentChar->notify();
  Serial.println("[STU→] " + m);
}

void applyTxPower() {
  esp_power_level_t lvl = mounted ? TX_MOUNTED : TX_HANDHELD;
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV,     lvl);
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_SCAN,    lvl);
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, lvl);
  for (int i = 0; i <= 8; i++) esp_ble_tx_power_set((esp_ble_power_type_t)i, lvl);   // connection handles
  Serial.println(String("[BLE] TX power ") + (mounted ? "MOUNTED (+9 dBm)" : "HANDHELD (+3 dBm)"));
}

// Advertisement = flags + service UUID.  Scan response = name + manufacturer data:
//   FF FF 'P' 'M' <'H'|'M'> <'0'|'1'>      (mode, session active)
void refreshAdvertising() {
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  if (advRunning) { adv->stop(); advRunning = false; }

  BLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.setCompleteServices(BLEUUID(SERVICE_UUID));

  BleStr md;
  md += (char)0xFF; md += (char)0xFF;
  md += 'P'; md += 'M';
  md += (mounted ? 'M' : 'H');
  md += (sessionActive ? '1' : '0');

  BLEAdvertisementData scanData;
  scanData.setName(DEVICE_NAME);
  scanData.setManufacturerData(md);

  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanData);
  adv->setMinInterval(mounted ? ADV_INT_MOUNTED : ADV_INT_HANDHELD);
  adv->setMaxInterval(mounted ? ADV_INT_MOUNTED + 0x10 : ADV_INT_HANDHELD + 0x10);
  adv->start();
  advRunning = true;
  needAdvRefresh = false;
  Serial.println(String("[BLE] Advertising  mode=") + (mounted ? "M" : "H") + " session=" + (sessionActive ? "1" : "0"));
}

void setMode(bool m) {
  if (m == mounted) return;
  mounted = m;
  prefs.putString("mode", mounted ? "M" : "H");
  applyTxPower();
  needAdvRefresh = true;
}

void clearSession() {
  sessionActive = false;
  lectureSessionId = attendanceSessionId = apiUrl = "";
  xSemaphoreTake(qMutex, portMAX_DELAY);
  markQueue.clear();
  markedCache.clear();
  xSemaphoreGive(qMutex);
  http.end();
  needAdvRefresh = true;
}

// ───────────────────────── Wi-Fi ─────────────────────────
// Returns "" on success, otherwise the failure reason (auth | nossid | timeout)
String joinWifi(const String& ssid, const String& pass, int timeoutSec) {
  deviceState = "WIFI_CONNECT";
  WiFi.disconnect(false);
  delay(100);
  WiFi.begin(ssid.c_str(), pass.length() ? pass.c_str() : nullptr);

  for (int i = 0; i < timeoutSec * 10; i++) {
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECTED) { deviceState = "READY"; return ""; }
    if (st == WL_NO_SSID_AVAIL && i > 30) { deviceState = "NO_WIFI"; return "nossid"; }   // not seen after ~3 s
    updateLED();
    delay(100);
  }
  wl_status_t st = WiFi.status();
  deviceState = "NO_WIFI";
  if (st == WL_NO_SSID_AVAIL) return "nossid";
  if (st == WL_CONNECT_FAILED) return "auth";
  return "timeout";
}

void processWifiRequest() {
  if (!pendingWifi) return;
  pendingWifi = false;
  String ssid = pendSsid, pass = pendPass;
  pendPass = "";

  Serial.println("[WiFi] Teacher asked to join: " + ssid);
  String err = joinWifi(ssid, pass, WIFI_JOIN_TIMEOUT);

  if (err.isEmpty()) {
    savedSsid = ssid; savedPass = pass;
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    Serial.println("[WiFi] Connected, IP " + WiFi.localIP().toString());
    notifyControl("WIFI_OK");
  } else {
    Serial.println("[WiFi] Failed: " + err);
    // fall back to the previously saved network, if any
    if (savedSsid.length()) WiFi.begin(savedSsid.c_str(), savedPass.length() ? savedPass.c_str() : nullptr);
    notifyControl("WIFI_FAIL:" + err);
  }
  // acknowledged → let go of the teacher's phone shortly after the notification is out
  teacherDropAt = millis() + 700;
}

void keepWifiAlive() {
  if (pendingWifi || savedSsid.isEmpty()) return;
  unsigned long now = millis();
  if (now - lastWifiCheck < 15000) return;
  lastWifiCheck = now;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Lost, reconnecting…");
    WiFi.disconnect(false);
    WiFi.begin(savedSsid.c_str(), savedPass.length() ? savedPass.c_str() : nullptr);
    deviceState = "WIFI_CONNECT";
  } else if (deviceState == "WIFI_CONNECT" || deviceState == "NO_WIFI" || deviceState == "BOOT") {
    deviceState = "READY";
  }
}

// ───────────────────────── LED (non-blocking) ─────────────────────────
void updateLED() {
  unsigned long now = millis();
  bool on = false;
  if (sessionActive)                         on = (now % 2000) < 80;            // short flash every 2 s
  else if (deviceState == "READY")           on = (now % 6000) < 3000;          // slow heartbeat
  else if (deviceState == "WIFI_CONNECT")    on = (now % 300)  < 150;           // fast blink
  else if (deviceState == "NO_WIFI")         on = (now % 1600) < 800;           // slow blink = needs setup
  else                                       on = (now % 200)  < 100;           // BOOT
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// ───────────────────────── BLE callbacks ─────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* p) override {
    for (auto& c : conns) if (c.id == 0xFFFF) { c.id = p->connect.conn_id; c.at = millis(); break; }
    Serial.println("[BLE] Client connected (" + String(s->getConnectedCount()) + ")");
    advRunning = false;
    needAdvRefresh = true;                 // keep accepting more students while slots are free
  }
  void onDisconnect(BLEServer* s, esp_ble_gatts_cb_param_t* p) override {
    for (auto& c : conns) if (c.id == p->disconnect.conn_id) c.id = 0xFFFF;
    advRunning = false;
    needAdvRefresh = true;
    Serial.println("[BLE] Client disconnected (" + String(s->getConnectedCount()) + ")");
  }
};

void handleControl(const String& line) {
  StaticJsonDocument<640> d;
  if (deserializeJson(d, line)) { notifyControl("BAD_CMD"); return; }

  const char* key = d["k"] | "";
  if (strcmp(key, SETUP_KEY) != 0) { notifyControl("AUTH_ERR"); return; }

  String cmd = String((const char*)(d["c"] | ""));

  if (cmd == "wifi") {
    String ssid = String((const char*)(d["ssid"] | ""));
    if (ssid.isEmpty() || pendingWifi) { notifyControl("BAD_CMD"); return; }
    pendSsid = ssid;
    pendPass = String((const char*)(d["pass"] | ""));
    pendingWifi = true;
    notifyControl("RX");

  } else if (cmd == "session") {
    String lec = String((const char*)(d["lec"] | ""));
    String att = String((const char*)(d["att"] | ""));
    String api = String((const char*)(d["api"] | ""));
    String m   = String((const char*)(d["mode"] | "handheld"));
    if (lec.isEmpty() || att.isEmpty() || api.isEmpty()) { notifyControl("SESSION_ERR"); return; }
    if (WiFi.status() != WL_CONNECTED) { notifyControl("NO_WIFI"); return; }

    while (api.endsWith("/")) api.remove(api.length() - 1);
    clearSession();                         // fresh queue + cache
    lectureSessionId = lec; attendanceSessionId = att; apiUrl = api;
    setMode(m == "mounted");
    sessionActive = true;
    needAdvRefresh = true;
    teacherDropAt = millis() + 700;
    notifyControl("SESSION_OK");
    Serial.println("[Session] started  lec=" + lec + " att=" + att + " mode=" + m);

  } else if (cmd == "stop") {
    clearSession();
    teacherDropAt = millis() + 700;
    notifyControl("STOPPED");
    Serial.println("[Session] stopped");

  } else if (cmd == "status") {
    StaticJsonDocument<160> o;
    o["w"] = WiFi.status() == WL_CONNECTED ? 1 : 0;
    o["s"] = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : savedSsid;
    o["m"] = mounted ? "M" : "H";
    o["a"] = sessionActive ? 1 : 0;
    String out; serializeJson(o, out);
    notifyControl("STATUS:" + out);

  } else {
    notifyControl("BAD_CMD");
  }
}

class ControlCallbacks : public BLECharacteristicCallbacks {
  // Only buffers the bytes – parsing / Wi-Fi / HTTP happen in loop() (the BLE task has a small stack).
  void onWrite(BLECharacteristic* c, esp_ble_gatts_cb_param_t* param) override {
    ctrlConnId = param->write.conn_id;
    String chunk = String(c->getValue().c_str());
    xSemaphoreTake(qMutex, portMAX_DELAY);
    ctrlBuf += chunk;
    if (ctrlBuf.length() > 900) ctrlBuf = "";
    int nl;
    while ((nl = ctrlBuf.indexOf('\n')) >= 0) {
      String line = ctrlBuf.substring(0, nl);
      ctrlBuf.remove(0, nl + 1);
      line.trim();
      if (line.length() && ctrlLines.size() < 4) ctrlLines.push_back(line);
    }
    xSemaphoreGive(qMutex);
  }
};

void processControl() {
  String line;
  xSemaphoreTake(qMutex, portMAX_DELAY);
  bool have = !ctrlLines.empty();
  if (have) { line = ctrlLines.front(); ctrlLines.erase(ctrlLines.begin()); }
  xSemaphoreGive(qMutex);
  if (have) handleControl(line);
}

class StudentCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String uid = String(c->getValue().c_str());
    uid.trim();
    if (uid.isEmpty() || uid.length() > 128) { notifyStudent(uid, "ERR"); return; }
    if (!sessionActive)                      { notifyStudent(uid, "NO_SESSION"); return; }

    bool already = false, full = false, waiting = false;
    xSemaphoreTake(qMutex, portMAX_DELAY);
    for (auto& u : markedCache) if (u == uid) { already = true; break; }
    if (!already) {
      for (auto& q : markQueue) if (q.uid == uid) { waiting = true; break; }   // duplicate write – already queued
      if (!waiting) {
        if (markQueue.size() >= MAX_QUEUE) full = true;
        else markQueue.push_back({uid, millis()});
      }
    }
    xSemaphoreGive(qMutex);

    if (already)      notifyStudent(uid, "ALREADY");
    else if (full)    notifyStudent(uid, "BUSY");
    // otherwise the answer is sent from loop() once the backend has replied
  }
};

// ───────────────────────── marking (runs in loop) ─────────────────────────
void rememberMarked(const String& uid) {
  xSemaphoreTake(qMutex, portMAX_DELAY);
  if (markedCache.size() >= MAX_MARKED_CACHE) markedCache.erase(markedCache.begin());
  markedCache.push_back(uid);
  xSemaphoreGive(qMutex);
}

void processOneMark() {
  MarkReq req;
  xSemaphoreTake(qMutex, portMAX_DELAY);
  bool have = false;
  while (!markQueue.empty()) {
    req = markQueue.front();
    markQueue.erase(markQueue.begin());
    if (millis() - req.at > QUEUE_STALE_MS) continue;       // student has timed out already
    have = true; break;
  }
  xSemaphoreGive(qMutex);
  if (!have) return;

  if (!sessionActive)                      { notifyStudent(req.uid, "NO_SESSION"); return; }
  if (WiFi.status() != WL_CONNECTED)       { notifyStudent(req.uid, "ERR");        return; }

  String sessTag = attendanceSessionId.length() > 6 ? attendanceSessionId.substring(attendanceSessionId.length() - 6) : attendanceSessionId;
  String endpoint = apiUrl + "/api/lectures/attendance/iot/mark";

  StaticJsonDocument<384> payload;
  payload["attendance_session_id"] = attendanceSessionId;
  payload["lecture_session_id"]    = lectureSessionId;
  payload["student_uid"]           = req.uid;
  payload["device_id"]             = WiFi.macAddress();
  String body; serializeJson(payload, body);

  WiFiClient* cl = &plainClient;
  if (apiUrl.startsWith("https")) { secureClient.setInsecure(); cl = &secureClient; }

  int code = -1; String resp;
  for (int attempt = 0; attempt < 2; attempt++) {
    http.setReuse(true);
    http.setTimeout(6000);
    if (!http.begin(*cl, endpoint)) { delay(200); continue; }
    http.addHeader("Content-Type", "application/json");
    code = http.POST(body);
    if (code > 0) resp = http.getString();
    http.end();
    if (code > 0) break;
    delay(300);
  }
  Serial.println("[Mark] " + req.uid + " → HTTP " + String(code));

  if (code < 200 || code >= 300) { notifyStudent(req.uid, "ERR"); return; }

  StaticJsonDocument<512> r;
  if (deserializeJson(r, resp)) { notifyStudent(req.uid, "ERR"); return; }

  bool success = r["success"] | false;
  bool already = r["already_marked"] | false;
  if (success) rememberMarked(req.uid);
  if (success && already) notifyStudent(req.uid, "ALREADY");
  else if (success)       notifyStudent(req.uid, "OK", sessTag);
  else                    notifyStudent(req.uid, "ERR");
}

// ───────────────────────── BLE setup ─────────────────────────
void startBLE() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(185);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService* svc = bleServer->createService(SERVICE_UUID);

  controlChar = svc->createCharacteristic(CONTROL_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
  controlChar->addDescriptor(new BLE2902());
  controlChar->setCallbacks(new ControlCallbacks());

  studentChar = svc->createCharacteristic(STUDENT_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
  studentChar->addDescriptor(new BLE2902());
  studentChar->setCallbacks(new StudentCallbacks());

  svc->start();
  applyTxPower();
  refreshAdvertising();
}

// ───────────────────────── Arduino ─────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  qMutex = xSemaphoreCreateMutex();
  for (auto& c : conns) c.id = 0xFFFF;
  markQueue.reserve(MAX_QUEUE);
  markedCache.reserve(MAX_MARKED_CACHE);

  prefs.begin("pm", false);
  savedSsid = prefs.getString("ssid", "");
  savedPass = prefs.getString("pass", "");
  mounted   = prefs.getString("mode", "H") == "M";

  // Wi-Fi modem sleep must stay ON while BLE is active (ESP32 coexistence requirement).
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  startBLE();

  if (savedSsid.length()) {
    Serial.println("[WiFi] Rejoining saved network: " + savedSsid);
    WiFi.begin(savedSsid.c_str(), savedPass.length() ? savedPass.c_str() : nullptr);
    deviceState = "WIFI_CONNECT";
  } else {
    deviceState = "NO_WIFI";            // waits for the teacher's phone
  }
  Serial.println("[Boot] PresenceMarker ready (BLE only)");
}

void loop() {
  updateLED();
  processControl();
  processWifiRequest();
  keepWifiAlive();

  if (sessionActive) processOneMark();

  // let go of the teacher's phone shortly after the final acknowledgement
  if (teacherDropAt && millis() > teacherDropAt) {
    teacherDropAt = 0;
    if (ctrlConnId >= 0) { bleServer->disconnect((uint16_t)ctrlConnId); ctrlConnId = -1; }
  }

  // drop clients that hang around (stalled students)
  for (auto& c : conns)
    if (c.id != 0xFFFF && millis() - c.at > CONN_MAX_MS) { bleServer->disconnect(c.id); c.id = 0xFFFF; }

  if (needAdvRefresh && bleServer->getConnectedCount() < 3) refreshAdvertising();
  else if (needAdvRefresh) needAdvRefresh = false;   // full – will refresh when a slot frees up (onDisconnect sets it again)

  delay(5);
}
