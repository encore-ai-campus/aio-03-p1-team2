#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
uv sync --frozen "$@"
uv run --no-sync python -m scripts.prepare_motion_model
