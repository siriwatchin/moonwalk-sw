import time

from arduino.app_utils import App, Bridge

from motion import MotionSample, parse_motion_values
from stream_protocol import encode_sample_line

state: dict[str, MotionSample | None] = {
    "latest": None,
}


def on_motion_update(ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps):
    sample = parse_motion_values((ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps))
    state["latest"] = sample

    print(encode_sample_line(sample), flush=True)


def loop():
    time.sleep(0.05)


Bridge.provide("motion_update", on_motion_update)
App.run(user_loop=loop)
