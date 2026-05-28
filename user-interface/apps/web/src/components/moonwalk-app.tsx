"use client";

import { useMemo, useState } from "react";

import { AddDeviceOverlay } from "@/components/moonwalk/add-device-overlay";
import { BiofeedbackPage } from "@/components/moonwalk/biofeedback-page";
import { BluetoothConnectOverlay } from "@/components/moonwalk/bluetooth-connect-overlay";
import { BottomNav } from "@/components/moonwalk/bottom-nav";
import { StickyDeviceBar } from "@/components/moonwalk/device-bar";
import { HomePage } from "@/components/moonwalk/home-page";
import { SettingsPage } from "@/components/moonwalk/settings-page";
import { SignalsPage } from "@/components/moonwalk/signals-page";
import { useBluetoothDevice } from "@/hooks/use-bluetooth-device";
import { useMounted } from "@/hooks/use-mounted";
import { devices, type DeviceId, type PageId } from "@/components/moonwalk-data";

export default function MoonWalkApp() {
  const isMounted = useMounted();
  const [activePage, setActivePage] = useState<PageId>("home");
  const [selectedDevice, setSelectedDevice] = useState<DeviceId>("cane");
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const [isAddDeviceOpen, setIsAddDeviceOpen] = useState(false);
  const [isBluetoothOpen, setIsBluetoothOpen] = useState(false);
  const bluetooth = useBluetoothDevice();

  const selectedDeviceLabel = devices.find(
    (device) => device.id === selectedDevice,
  )?.label;

  const content = useMemo(() => {
    if (activePage === "biofeedback") {
      return <BiofeedbackPage selectedDevice={selectedDevice} />;
    }

    if (activePage === "signals") {
      return (
        <SignalsPage
          badPacketCount={bluetooth.badPacketCount}
          isBluetoothConnected={bluetooth.isConnected}
          latestSample={bluetooth.latestSample}
          packetCount={bluetooth.packetCount}
        />
      );
    }

    if (activePage === "settings") {
      return (
        <SettingsPage
          bluetoothDevice={bluetooth.device}
          bluetoothState={bluetooth.state}
          onOpenBluetooth={() => setIsBluetoothOpen(true)}
        />
      );
    }

    return (
      <HomePage
        selectedDevice={selectedDevice}
        isBluetoothConnected={bluetooth.isConnected}
      />
    );
  }, [
    activePage,
    bluetooth.badPacketCount,
    bluetooth.isConnected,
    bluetooth.latestSample,
    bluetooth.packetCount,
    bluetooth.state,
    selectedDevice,
  ]);

  if (!isMounted) {
    return (
      <main className="min-h-0 overflow-y-auto bg-moonwalk-white text-moonwalk-navy dark:bg-moonwalk-navy dark:text-moonwalk-white">
        <div className="font-line-seed-th mx-auto grid min-h-full w-full max-w-6xl gap-2 px-3 pb-20 pt-0 md:px-5 md:pt-3">
          <section className="sticky top-0 z-10 -mx-3 border-y border-moonwalk-navy bg-moonwalk-white text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-navy dark:text-moonwalk-white md:mx-0 md:border-x">
            <div className="h-12 border-b border-moonwalk-white bg-moonwalk-navy" />
            <div className="h-12" />
          </section>
          <section className="h-32 border border-moonwalk-navy bg-moonwalk-navy" />
          <section className="h-24 border border-moonwalk-silver dark:border-moonwalk-slate" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-0 overflow-y-auto bg-moonwalk-white text-moonwalk-navy dark:bg-moonwalk-navy dark:text-moonwalk-white">
      <div className="font-line-seed-th mx-auto grid min-h-full w-full max-w-6xl gap-2 px-3 pb-20 pt-0 md:px-5 md:pt-3">
        <StickyDeviceBar
          selectedDevice={selectedDevice}
          onDeviceChange={setSelectedDevice}
          isOpen={isDeviceMenuOpen}
          onToggleOpen={() => setIsDeviceMenuOpen((value) => !value)}
          onAddDevice={() => {
            setIsDeviceMenuOpen(false);
            setIsAddDeviceOpen(true);
          }}
          bluetoothDevice={bluetooth.device}
          bluetoothError={bluetooth.error}
          bluetoothState={bluetooth.state}
          isBluetoothPending={bluetooth.isPending}
          onBluetoothConnect={() => setIsBluetoothOpen(true)}
          onBluetoothDisconnect={bluetooth.disconnect}
        />

        {content}

        <div className="border border-moonwalk-silver bg-moonwalk-white p-2 text-xs text-moonwalk-slate dark:border-moonwalk-white/20 dark:bg-moonwalk-navy dark:text-moonwalk-white/65">
          <span>โมดูลติดตั้งกับ {selectedDeviceLabel}</span>
        </div>
      </div>

      <BottomNav activePage={activePage} onPageChange={setActivePage} />

      {isAddDeviceOpen ? (
        <AddDeviceOverlay onClose={() => setIsAddDeviceOpen(false)} />
      ) : null}

      {isBluetoothOpen ? (
        <BluetoothConnectOverlay
          connectedDevice={bluetooth.device}
          error={bluetooth.error}
          isPending={bluetooth.isPending}
          knownDevices={bluetooth.knownDevices}
          onClose={() => setIsBluetoothOpen(false)}
          onConnect={bluetooth.connect}
          onConnectKnownDevice={bluetooth.connectKnownDevice}
          onDisconnect={bluetooth.disconnect}
          onRefreshKnownDevices={bluetooth.refreshKnownDevices}
          state={bluetooth.state}
        />
      ) : null}
    </main>
  );
}
