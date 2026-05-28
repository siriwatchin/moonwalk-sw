type BluetoothServiceUUID = number | string;

type RequestDeviceOptions =
  | {
      acceptAllDevices: true;
      optionalServices?: BluetoothServiceUUID[];
    }
  | {
      filters: Array<{
        name?: string;
        namePrefix?: string;
        services?: BluetoothServiceUUID[];
      }>;
      optionalServices?: BluetoothServiceUUID[];
    };

interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(
    service: BluetoothServiceUUID,
  ): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(
    characteristic: BluetoothServiceUUID,
  ): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

interface Bluetooth extends EventTarget {
  getAvailability?(): Promise<boolean>;
  getDevices?(): Promise<BluetoothDevice[]>;
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  bluetooth?: Bluetooth;
}
