"use client";

import { useCallback, useEffect, useState } from "react";

import {
  decodeNanoImuValue,
  NANO_IMU_CHAR_UUID,
  NANO_IMU_DEVICE_NAME,
  NANO_IMU_SERVICE_UUID,
  parseNanoImuPayload,
  type NanoImuSample,
} from "@/lib/nano-imu";

export type BluetoothConnectionState =
  | "ios-unsupported"
  | "unsupported"
  | "idle"
  | "searching"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type BluetoothDeviceSnapshot = {
  id: string;
  name: string;
};

export type BluetoothConnectMode = "supported" | "all";

const optionalServices: BluetoothServiceUUID[] = [
  NANO_IMU_SERVICE_UUID,
  "battery_service",
  "device_information",
];

function isIosWebBluetoothHost() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent;
  const platform = navigator.platform;
  const isTouchMac =
    platform === "MacIntel" && "maxTouchPoints" in navigator && navigator.maxTouchPoints > 1;

  return /iPad|iPhone|iPod/.test(userAgent) || isTouchMac;
}

function toDeviceSnapshot(device: BluetoothDevice): BluetoothDeviceSnapshot {
  return {
    id: device.id,
    name: device.name ?? "อุปกรณ์ Bluetooth",
  };
}

async function connectGattServer(device: BluetoothDevice) {
  if (!device.gatt) {
    throw new Error("อุปกรณ์นี้ไม่มี GATT server สำหรับเชื่อมต่อ");
  }

  const server = device.gatt.connected
    ? device.gatt
    : await device.gatt.connect();

  if (!server.connected) {
    return device.gatt.connect();
  }

  return server;
}

function formatBluetoothError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "เชื่อมต่อ Bluetooth ไม่สำเร็จ";

  if (
    message.includes("GATT Server is disconnected") ||
    message.includes("NetworkError")
  ) {
    return "อุปกรณ์ตัดการเชื่อมต่อระหว่างอ่าน service กรุณาเปิด NanoIMU ให้อยู่ใกล้ แล้วลองเชื่อมต่ออีกครั้ง";
  }

  if (
    message.includes("No Services matching UUID") ||
    message.includes("No Characteristics matching UUID") ||
    message.includes("not found")
  ) {
    return "อุปกรณ์นี้ไม่พบ NanoIMU service/characteristic กรุณาเลือก NanoIMU";
  }

  return message;
}

export function useBluetoothDevice() {
  const [state, setState] = useState<BluetoothConnectionState>("idle");
  const [device, setDevice] = useState<BluetoothDeviceSnapshot | null>(null);
  const [knownDevices, setKnownDevices] = useState<BluetoothDeviceSnapshot[]>(
    [],
  );
  const [knownBluetoothDevices, setKnownBluetoothDevices] = useState<
    BluetoothDevice[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [latestSample, setLatestSample] = useState<NanoImuSample | null>(null);
  const [packetCount, setPacketCount] = useState(0);
  const [badPacketCount, setBadPacketCount] = useState(0);
  const [bluetoothDevice, setBluetoothDevice] =
    useState<BluetoothDevice | null>(null);
  const [imuCharacteristic, setImuCharacteristic] =
    useState<BluetoothRemoteGATTCharacteristic | null>(null);

  useEffect(() => {
    if (!navigator.bluetooth) {
      setState(isIosWebBluetoothHost() ? "ios-unsupported" : "unsupported");
      return;
    }

    navigator.bluetooth
      .getAvailability?.()
      .then((isAvailable) => {
        setState(isAvailable ? "idle" : "unsupported");
      })
      .catch(() => {
        setState("idle");
      });
  }, []);

  const refreshKnownDevices = useCallback(async () => {
    if (!navigator.bluetooth?.getDevices) {
      setKnownBluetoothDevices([]);
      setKnownDevices([]);
      return;
    }

    const nextDevices = await navigator.bluetooth.getDevices();
    const supportedFirst = [...nextDevices].sort((first, second) => {
      const firstSupported = first.name?.startsWith(NANO_IMU_DEVICE_NAME)
        ? 0
        : 1;
      const secondSupported = second.name?.startsWith(NANO_IMU_DEVICE_NAME)
        ? 0
        : 1;

      return firstSupported - secondSupported;
    });

    setKnownBluetoothDevices(supportedFirst);
    setKnownDevices(supportedFirst.map(toDeviceSnapshot));
  }, []);

  useEffect(() => {
    void refreshKnownDevices();
  }, [refreshKnownDevices]);

  useEffect(() => {
    if (!bluetoothDevice) {
      return;
    }

    const handleDisconnect = () => {
      setState("disconnected");
      setImuCharacteristic(null);
    };

    bluetoothDevice.addEventListener(
      "gattserverdisconnected",
      handleDisconnect,
    );

    return () => {
      bluetoothDevice.removeEventListener(
        "gattserverdisconnected",
        handleDisconnect,
      );
    };
  }, [bluetoothDevice]);

  const connectToDevice = useCallback(async (nextDevice: BluetoothDevice) => {
    setBluetoothDevice(nextDevice);
    setDevice(toDeviceSnapshot(nextDevice));

    setState("connecting");
    let server = await connectGattServer(nextDevice);
    let characteristic: BluetoothRemoteGATTCharacteristic;

    try {
      const service = await server.getPrimaryService(NANO_IMU_SERVICE_UUID);
      characteristic = await service.getCharacteristic(NANO_IMU_CHAR_UUID);
    } catch (serviceError) {
      if (!nextDevice.gatt?.connected) {
        server = await connectGattServer(nextDevice);
        const service = await server.getPrimaryService(NANO_IMU_SERVICE_UUID);
        characteristic = await service.getCharacteristic(NANO_IMU_CHAR_UUID);
      } else {
        throw serviceError;
      }
    }

    setImuCharacteristic(characteristic);
    const initialValue = await characteristic.readValue();
    const initialSample = parseNanoImuPayload(decodeNanoImuValue(initialValue));

    if (initialSample) {
      setLatestSample(initialSample);
    }

    await characteristic.startNotifications();
    setState("connected");
  }, []);

  const connect = useCallback(async (mode: BluetoothConnectMode = "supported") => {
    if (!navigator.bluetooth) {
      const isIos = isIosWebBluetoothHost();

      setState(isIos ? "ios-unsupported" : "unsupported");
      setError(
        isIos
          ? "iOS Safari ไม่รองรับ Web Bluetooth โดยตรง กรุณาใช้ WebBLE/Bluefy หรือแอป iOS สำหรับเชื่อมต่อ NanoIMU"
          : "เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth",
      );
      return;
    }

    try {
      setError(null);
      setState("searching");

      const requestOptions: RequestDeviceOptions =
        mode === "all"
          ? { acceptAllDevices: true, optionalServices }
          : {
              filters: [
                { name: NANO_IMU_DEVICE_NAME },
                { namePrefix: NANO_IMU_DEVICE_NAME },
              ],
              optionalServices,
            };

      const nextDevice = await navigator.bluetooth.requestDevice(requestOptions);

      await connectToDevice(nextDevice);
      await refreshKnownDevices();
    } catch (requestError) {
      const message = formatBluetoothError(requestError);

      setState(message.includes("cancel") ? "idle" : "error");
      setError(message);
    }
  }, [connectToDevice, refreshKnownDevices]);

  const connectKnownDevice = useCallback(
    async (deviceId: string) => {
      const nextDevice = knownBluetoothDevices.find(
        (knownDevice) => knownDevice.id === deviceId,
      );

      if (!nextDevice) {
        setState("error");
        setError("ไม่พบอุปกรณ์นี้ในรายการที่เบราว์เซอร์อนุญาตไว้");
        return;
      }

      try {
        setError(null);
        await connectToDevice(nextDevice);
      } catch (connectError) {
        const message = formatBluetoothError(connectError);

        setState("error");
        setError(message);
      }
    },
    [connectToDevice, knownBluetoothDevices],
  );

  const disconnect = useCallback(() => {
    void imuCharacteristic?.stopNotifications().catch(() => undefined);
    bluetoothDevice?.gatt?.disconnect();
    setImuCharacteristic(null);
    setState("disconnected");
  }, [bluetoothDevice, imuCharacteristic]);

  useEffect(() => {
    if (!imuCharacteristic) {
      return;
    }

    const handleCharacteristicValueChanged = (event: Event) => {
      const characteristic =
        event.currentTarget as BluetoothRemoteGATTCharacteristic;

      if (!characteristic.value) {
        return;
      }

      const sample = parseNanoImuPayload(
        decodeNanoImuValue(characteristic.value),
      );

      if (!sample) {
        setBadPacketCount((count) => count + 1);
        return;
      }

      setLatestSample(sample);
      setPacketCount((count) => count + 1);
    };

    imuCharacteristic.addEventListener(
      "characteristicvaluechanged",
      handleCharacteristicValueChanged,
    );

    return () => {
      imuCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        handleCharacteristicValueChanged,
      );
    };
  }, [imuCharacteristic]);

  return {
    badPacketCount,
    connect,
    connectKnownDevice,
    disconnect,
    device,
    error,
    isConnected: state === "connected",
    isPending: state === "searching" || state === "connecting",
    knownDevices,
    latestSample,
    packetCount,
    refreshKnownDevices,
    state,
  };
}
