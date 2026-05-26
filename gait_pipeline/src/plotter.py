"""Optional live plot of acc_norm / gyro_norm / phase over time.

matplotlib is imported lazily so the core pipeline runs without it. If it isn't
installed, constructing LivePlotter raises ImportError; main() catches that and
continues without plotting.
"""

from __future__ import annotations

from collections import deque

from .models import ImuSample

_MAXLEN = 400          # ~20 s of history at 20 Hz
_REDRAW_EVERY = 5      # throttle: redraw once every N samples


class LivePlotter:
    def __init__(self, maxlen: int = _MAXLEN):
        import matplotlib.pyplot as plt  # lazy import

        self._plt = plt
        self._t = deque(maxlen=maxlen)
        self._acc = deque(maxlen=maxlen)
        self._gyro = deque(maxlen=maxlen)
        self._phase = deque(maxlen=maxlen)
        self._count = 0

        plt.ion()
        self._fig, (self._ax_acc, self._ax_gyro, self._ax_phase) = plt.subplots(
            3, 1, sharex=True, figsize=(8, 6)
        )
        (self._l_acc,) = self._ax_acc.plot([], [], color="tab:blue")
        (self._l_gyro,) = self._ax_gyro.plot([], [], color="tab:orange")
        (self._l_phase,) = self._ax_phase.step([], [], where="post", color="tab:green")
        self._ax_acc.set_ylabel("acc_norm\n(m/s²)")
        self._ax_gyro.set_ylabel("gyro_norm\n(deg/s)")
        self._ax_phase.set_ylabel("phase")
        self._ax_phase.set_xlabel("time (s)")
        self._ax_phase.set_yticks([0, 1, 2, 3])
        self._fig.suptitle("NanoIMU mock — live")
        self._fig.tight_layout()

    def update(self, sample: ImuSample) -> None:
        self._t.append(sample.timestamp_ms / 1000.0)
        self._acc.append(sample.acc_norm)
        self._gyro.append(sample.gyro_norm)
        self._phase.append(sample.phase)
        self._count += 1
        if self._count % _REDRAW_EVERY:
            return

        self._l_acc.set_data(self._t, self._acc)
        self._l_gyro.set_data(self._t, self._gyro)
        self._l_phase.set_data(self._t, self._phase)
        for ax in (self._ax_acc, self._ax_gyro, self._ax_phase):
            ax.relim()
            ax.autoscale_view()
        self._plt.pause(0.001)

    def close(self) -> None:
        self._plt.ioff()
        self._plt.show()
