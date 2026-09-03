"""Bhoomi-Drishti machine-learning package.

Layout
------
features.py      canonical feature contract shared by training and serving
physics.py       physically-informed hazard model (label generator + fallback)
hydrology.py     hourly rainfall process and soil-moisture water balance
fallback_gbm.py  dependency-free Newton gradient-boosting reference model
preprocess.py    feature-vector assembly, encoding and validation
train_model.py   training entry point  ->  model.pkl
predict.py       inference entry point (used by the FastAPI backend)
explain.py       SHAP / exact tree-path contribution explanations
"""

__version__ = "1.0.0"
MODEL_NAME = "bhoomi-drishti-landslide-hazard"
MODEL_VERSION = "1.0.0"
