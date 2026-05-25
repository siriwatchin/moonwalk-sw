from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd
import plotly.express as px
import streamlit as st

from collection_interface.serial_io import list_serial_ports, open_serial, read_available_lines
from collection_interface.utils import (
    apply_metadata,
    downsample_samples,
    export_csv,
    export_jsonl,
    export_manifest,
    generate_demo_samples,
    parse_protocol_text,
    parse_uploaded_text,
    samples_to_frame_rows,
    summarize_samples,
    trim_samples,
)


APP_TITLE = "Moon Walk Collection Interface"
SAFETY_FOOTER = "Wellness self-monitoring only: a wellness awareness cue, not a medical assessment."


def init_state() -> None:
    st.session_state.setdefault("samples", [])
    st.session_state.setdefault("errors", [])
    st.session_state.setdefault("serial_connection", None)
    st.session_state.setdefault("serial_port", "")
    st.session_state.setdefault("collect_live", False)


def close_serial() -> None:
    connection = st.session_state.get("serial_connection")
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass
    st.session_state.serial_connection = None
    st.session_state.collect_live = False


def append_errors(errors: list[str]) -> None:
    if errors:
        st.session_state.errors = (st.session_state.errors + errors)[-80:]


def append_samples(samples) -> None:
    st.session_state.samples.extend(samples)


def render_header() -> None:
    st.title(APP_TITLE)
    st.caption("External collector for Moon Walk hardware protocol lines.")


def render_sidebar() -> tuple[str, str, str]:
    st.sidebar.header("Session")
    session_name = st.sidebar.text_input("Session name", value="cane-posture-session")
    label = st.sidebar.text_input("Active label", value="walking")
    note = st.sidebar.text_area("Active note", height=88)

    if st.sidebar.button("Apply label and note to all samples", use_container_width=True):
        st.session_state.samples = apply_metadata(st.session_state.samples, label=label, note=note)
        st.sidebar.success("Updated current samples")

    st.sidebar.divider()
    st.sidebar.header("Live Serial")
    ports = list_serial_ports()
    port_labels = [f"{port.device} - {port.description}" for port in ports]
    selected = st.sidebar.selectbox("Port", port_labels or ["COM3 - manual entry fallback"])
    port = selected.split(" - ", 1)[0]
    manual_port = st.sidebar.text_input("Manual port override", value="" if ports else port)
    if manual_port.strip():
        port = manual_port.strip()

    baud_rate = st.sidebar.number_input("Baud rate", min_value=1200, max_value=921600, value=115200, step=9600)
    max_lines = st.sidebar.slider("Lines per refresh", min_value=1, max_value=250, value=60)
    refresh_s = st.sidebar.slider("Refresh seconds", min_value=0.1, max_value=3.0, value=0.5, step=0.1)

    col_a, col_b = st.sidebar.columns(2)
    with col_a:
        if st.button("Connect", use_container_width=True):
            try:
                st.session_state.serial_connection = open_serial(port, int(baud_rate))
                st.session_state.serial_port = port
                st.sidebar.success(f"Connected to {port}")
            except Exception as error:
                append_errors([str(error)])
                st.sidebar.error(str(error))
    with col_b:
        if st.button("Disconnect", use_container_width=True):
            close_serial()

    connected = st.session_state.serial_connection is not None
    st.session_state.collect_live = st.sidebar.toggle("Collect live", value=st.session_state.collect_live and connected, disabled=not connected)

    if st.session_state.collect_live:
        result = read_available_lines(st.session_state.serial_connection, max_lines=max_lines)
        append_samples(apply_metadata(result.samples, label=label, note=note))
        append_errors(result.errors)
        time.sleep(refresh_s)
        st.rerun()

    st.sidebar.divider()
    st.sidebar.header("Utilities")
    keep_last = st.sidebar.number_input("Keep last N samples", min_value=0, value=0, step=100)
    if st.sidebar.button("Trim session", use_container_width=True):
        st.session_state.samples = trim_samples(st.session_state.samples, keep_last=int(keep_last) or None)
    if st.sidebar.button("Add demo samples", use_container_width=True):
        append_samples(generate_demo_samples())
    if st.sidebar.button("Clear samples", use_container_width=True):
        st.session_state.samples = []
        st.session_state.errors = []

    return session_name, label, note


def render_import(label: str, note: str) -> None:
    with st.expander("Import protocol lines or saved files", expanded=False):
        pasted = st.text_area("Paste MWALK_MOTION_RAW, MWALK_MOTION_SAMPLE, or bare protocol JSON", height=150)
        uploaded = st.file_uploader("Upload JSONL, log, text, or CSV", type=["jsonl", "log", "txt", "csv"])

        if st.button("Import", use_container_width=True):
            samples = []
            errors = []
            if pasted.strip():
                result = parse_protocol_text(pasted)
                samples.extend(result.samples)
                errors.extend(result.errors)
            if uploaded is not None:
                text = uploaded.read().decode("utf-8", errors="replace")
                result = parse_uploaded_text(uploaded.name, text)
                samples.extend(result.samples)
                errors.extend(result.errors)

            append_samples(apply_metadata(samples, label=label, note=note))
            append_errors(errors)
            st.success(f"Imported {len(samples)} samples")


def render_summary(samples) -> None:
    summary = summarize_samples(samples)
    col_a, col_b, col_c, col_d, col_e = st.columns(5)
    col_a.metric("Samples", f"{summary['sample_count']}")
    col_b.metric("Duration", f"{summary['duration_s']:.1f}s")
    col_c.metric("Rate", f"{summary['sample_rate_hz']:.1f} Hz")
    col_d.metric("Mean tilt", f"{summary['mean_tilt_deg']:.1f} deg")
    col_e.metric("Max rate", f"{summary['max_angular_rate_dps']:.1f} dps")


def render_visuals(samples) -> None:
    if not samples:
        st.info("Connect serial, import a log, or add demo samples to begin.")
        return

    max_points = st.slider("Visualization point limit", min_value=200, max_value=10000, value=2500, step=100)
    visible_samples = downsample_samples(samples, max_points=max_points)
    frame = pd.DataFrame(samples_to_frame_rows(visible_samples))

    tab_signals, tab_distribution, tab_rows, tab_export = st.tabs(["Signals", "Distribution", "Rows", "Export"])

    with tab_signals:
        signals = st.multiselect(
            "Signal columns",
            ["ax_g", "ay_g", "az_g", "roll_dps", "pitch_dps", "yaw_dps", "tilt_deg", "accel_magnitude_g", "angular_rate_dps"],
            default=["tilt_deg", "angular_rate_dps", "ax_g", "az_g"],
        )
        if signals:
            long_frame = frame.melt(id_vars=["elapsed_s"], value_vars=signals, var_name="signal", value_name="value")
            fig = px.line(long_frame, x="elapsed_s", y="value", color="signal", labels={"elapsed_s": "elapsed (s)"})
            fig.update_layout(height=460, margin=dict(l=10, r=10, t=20, b=10), legend_title_text="")
            st.plotly_chart(fig, use_container_width=True)

    with tab_distribution:
        col_a, col_b = st.columns(2)
        posture_counts = frame["posture"].value_counts().rename_axis("posture").reset_index(name="samples")
        col_a.plotly_chart(px.bar(posture_counts, x="posture", y="samples"), use_container_width=True)
        labelled = frame[frame["label"] != ""]
        if labelled.empty:
            col_b.info("No labels applied yet.")
        else:
            label_counts = labelled["label"].value_counts().rename_axis("label").reset_index(name="samples")
            col_b.plotly_chart(px.bar(label_counts, x="label", y="samples"), use_container_width=True)

    with tab_rows:
        st.dataframe(frame, use_container_width=True, hide_index=True)

    with tab_export:
        session_name = st.session_state.get("session_name_for_export", "moonwalk-session")
        operator_note = st.text_area("Manifest note", height=90)
        st.download_button("Download CSV", export_csv(samples), file_name=f"{session_name}.csv", mime="text/csv")
        st.download_button("Download JSONL", export_jsonl(samples), file_name=f"{session_name}.jsonl", mime="application/jsonl")
        st.download_button(
            "Download manifest",
            export_manifest(samples, session_name=session_name, operator_note=operator_note),
            file_name=f"{session_name}.manifest.json",
            mime="application/json",
        )


def render_errors() -> None:
    if st.session_state.errors:
        with st.expander("Recent parse or serial errors", expanded=False):
            for error in st.session_state.errors[-12:]:
                st.warning(error)


def main() -> None:
    st.set_page_config(page_title=APP_TITLE, layout="wide")
    init_state()
    render_header()
    session_name, label, note = render_sidebar()
    st.session_state.session_name_for_export = session_name
    render_import(label, note)
    render_summary(st.session_state.samples)
    render_visuals(st.session_state.samples)
    render_errors()
    st.caption(SAFETY_FOOTER)


if __name__ == "__main__":
    main()
