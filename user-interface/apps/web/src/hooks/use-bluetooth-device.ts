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

const optionalServices: BluetoothServiceUUID[] = [
  NANO_IMU_SERVICE_UUID,
  "battery_service",
  "device_information",
];

export function useBluetoothDevice() {
  const [state, setState] = useState<BluetoothConnectionState>("idle");
  const [device, setDevice] = useState<BluetoothDeviceSnapshot | null>(null);
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
      setState("unsupported");
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

  const connect = useCallback(async () => {
    if (!navigator.bluetooth) {
      setState("unsupported");
      setError("เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth");
      return;
    }

    try {
      setError(null);
      setState("searching");

      const nextDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { name: NANO_IMU_DEVICE_NAME },
          { namePrefix: NANO_IMU_DEVICE_NAME },
        ],
        optionalServices,
      });

      setBluetoothDevice(nextDevice);
      setDevice({
        id: nextDevice.id,
        name: nextDevice.name ?? "อุปกรณ์ Bluetooth",
      });

      if (!nextDevice.gatt) {
        setState("error");
        setError("อุปกรณ์นี้ไม่มี GATT server สำหรับเชื่อมต่อ");
        return;
      }

      setState("connecting");
      const server = await nextDevice.gatt.connect();
      const service = await server.getPrimaryService(NANO_IMU_SERVICE_UUID);
      const characteristic =
        await service.getCharacteristic(NANO_IMU_CHAR_UUID);

      setImuCharacteristic(characteristic);
      const initialValue = await characteristic.readValue();
      const initialSample = parseNanoImuPayload(
        decodeNanoImuValue(initialValue),
      );

      if (initialSample) {
        setLatestSample(initialSample);
      }

      await characteristic.startNotifications();
      setState("connected");
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : "เชื่อมต่อ Bluetooth ไม่สำเร็จ";

      setState(message.includes("cancel") ? "idle" : "error");
      setError(message);
    }
  }, []);

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
    disconnect,
    device,
    error,
    isConnected: state === "connected",
    isPending: state === "searching" || state === "connecting",
    latestSample,
    packetCount,
    state,
  };
}
