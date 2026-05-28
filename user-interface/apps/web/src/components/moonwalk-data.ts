import {
  Activity,
  BarChart3,
  Brain,
  Home,
  Settings,
} from "lucide-react";

export type PageId = "home" | "biofeedback" | "signals" | "settings";
export type DeviceId = "cane" | "walker";

export const pages = [
  { id: "home", label: "หน้าหลัก", icon: Home },
  { id: "biofeedback", label: "ฟีดแบ็ก", icon: Brain },
  { id: "signals", label: "สัญญาณสด", icon: BarChart3 },
  { id: "settings", label: "ตั้งค่า", icon: Settings },
] satisfies Array<{ id: PageId; label: string; icon: typeof Home }>;

export const devices = [
  {
    id: "cane",
    label: "ไม้เท้า",
    description: "โมดูลติดตั้งกับไม้เท้าเดี่ยว สำหรับติดตามจังหวะการเดิน",
    iconSrc: "/icons/cane_icon.svg",
  },
  {
    id: "walker",
    label: "วอล์กเกอร์",
    description:
      "โมดูลติดตั้งกับวอล์กเกอร์หรือรถเข็นช่วยเดิน สำหรับติดตามการเคลื่อนที่",
    iconSrc: "/icons/walker_icon.svg",
  },
] satisfies Array<{
  id: DeviceId;
  label: string;
  description: string;
  iconSrc: string;
}>;

export const historyItems = [
  {
    date: "วันนี้",
    title: "เดินรอบเช้าในบ้าน",
    equipment: "ไม้เท้า",
    duration: "18 นาที",
    detail: "จังหวะสมดุลดีขึ้น 6 คะแนน และลงไม้เท้าสม่ำเสมอกว่ารอบก่อน",
    outcome: "เหมาะสำหรับเพิ่มรอบสั้นอีกครั้งช่วงเย็น",
  },
  {
    date: "เมื่อวาน",
    title: "ฝึกเดินทางตรง",
    equipment: "วอล์กเกอร์",
    duration: "14 นาที",
    detail: "ลงน้ำหนักอยู่ในเป้าหมายหลายรอบ แต่ช่วงท้ายเริ่มล้าจังหวะตก",
    outcome: "ควรพัก 1 นาทีเมื่อเดินเกิน 10 นาที",
  },
  {
    date: "จันทร์",
    title: "ตั้งค่า baseline เริ่มต้น",
    equipment: "ไม้เท้า",
    duration: "12 นาที",
    detail: "ระบบเก็บค่าพื้นฐานของจังหวะและเวลาลงไม้เท้าเพื่อใช้เปรียบเทียบ",
    outcome: "ใช้เป็นจุดอ้างอิงของสัปดาห์นี้",
  },
];

export const recommendations = [
  {
    title: "เริ่มด้วยรอบสั้น",
    detail: "เดิน 5 นาทีแรกด้วยความเร็วที่สบาย แล้วดูว่าจังหวะสมดุลยังอยู่ระดับปานกลางขึ้นไปหรือไม่",
  },
  {
    title: "ตรวจโมดูลก่อนเดิน",
    detail: "ให้โมดูลแนบกับไม้เท้าแน่น ไม่หมุน และเปิดบลูทูธก่อนเริ่มเพื่อให้ระบบไม่พลาดรอบก้าว",
  },
  {
    title: "ใช้แรงกดให้คงที่",
    detail: "ถ้าแถบคุณภาพลดลง ให้ลดแรงกดที่ด้ามจับเล็กน้อยและคงจังหวะเดิมอีก 1-2 นาที",
  },
];

export const liveSignals = [
  {
    label: "ax",
    value: "0.18",
    unit: "m/s²",
    bars: [20, 44, 38, 62, 55, 71, 48, 59, 77, 51, 69, 83],
  },
  {
    label: "ay",
    value: "-0.04",
    unit: "m/s²",
    bars: [31, 28, 46, 42, 64, 58, 49, 66, 53, 48],
  },
  {
    label: "az",
    value: "0.96",
    unit: "m/s²",
    bars: [72, 69, 76, 71, 80, 74, 78, 73, 79, 75, 82, 77],
  },
  {
    label: "gx",
    value: "12.4",
    unit: "dps",
    bars: [35, 52, 41, 67, 74, 63, 58, 81, 73, 66, 84, 70],
  },
  {
    label: "gy",
    value: "-8.7",
    unit: "dps",
    bars: [62, 56, 49, 44, 51, 39, 46, 58, 42, 37, 53, 48],
  },
  {
    label: "gz",
    value: "3.1",
    unit: "dps",
    bars: [18, 24, 33, 28, 39, 44, 36, 31, 47, 52, 43, 40],
  },
];
