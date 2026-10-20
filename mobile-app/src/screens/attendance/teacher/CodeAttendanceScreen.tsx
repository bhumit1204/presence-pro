import ProximityAttendanceScreen from "./ProximityAttendanceScreen";

// Teacher live screen — all logic lives in ProximityAttendanceScreen.
export { BLE_SERVICE_UUID } from "../../../utils/proximity";
export default function CodeAttendanceScreen() {
  return <ProximityAttendanceScreen mode="code" />;
}
