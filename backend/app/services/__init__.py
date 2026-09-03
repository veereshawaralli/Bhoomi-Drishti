"""Service layer.

Each module owns one concern and is import-safe on its own, so the routers
stay thin and the engine can be unit-tested without FastAPI:

=========================  ===================================================
scenario                   the four demo scenarios and the active-scenario state
weather_service            LIVE (public API) or DEMO (modelled) weather
terrain_service            static terrain features per region
risk_engine                feature assembly -> model -> stored prediction
forecast_service           the 72-hour risk curve
alert_service              threshold crossing -> alert -> response workflow
history_service            the landslide inventory: filters and charts
report_service             citizen reports: submission, screening, triage
sensor_simulator           the virtual (software-only) sensor network
image_analysis             screening of citizen-submitted photographs
whatif_service             counterfactual scoring for the simulator
overview_service           national roll-up computed from stored data
=========================  ===================================================

Two rules hold across all of them.

**One scoring path.** Every risk number in the platform - map, panel, forecast,
what-if, alert, sensor screen - is produced by ``risk_engine``, which is the
only caller of ``ml.predict``. A score therefore means the same thing wherever
it appears.

**Provenance travels with the value.** Nothing returns a bare number. Weather,
predictions, sensor readings and alerts all carry ``data_mode`` (LIVE, DEMO or
SIMULATED), set where the value is produced rather than guessed at the edge.
"""
