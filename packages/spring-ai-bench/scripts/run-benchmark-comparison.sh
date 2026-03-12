#!/usr/bin/env bash
#
# run-benchmark-comparison.sh
#
# Runs the coverage-uplift benchmark with both single-agent and multi-agent
# configurations, then produces a comparison report.
#
# Prerequisites:
#   - Java 21+, Maven, pnpm
#   - spring-ai-bench and spring-ai-agents built locally
#   - AgentFactory installed and configured
#
# Usage:
#   ./scripts/run-benchmark-comparison.sh [--benchmark <name>] [--skip-single] [--skip-multi]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCHMARK="coverage-uplift"
SKIP_SINGLE=false
SKIP_MULTI=false
REPORT_DIR="$PROJECT_DIR/bench-reports"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --benchmark) BENCHMARK="$2"; shift 2 ;;
        --skip-single) SKIP_SINGLE=true; shift ;;
        --skip-multi) SKIP_MULTI=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "========================================"
echo "AgentFactory Benchmark Comparison"
echo "========================================"
echo "Benchmark: $BENCHMARK"
echo "Report dir: $REPORT_DIR"
echo ""

mkdir -p "$REPORT_DIR"

# Run single-agent benchmark
if [ "$SKIP_SINGLE" = false ]; then
    echo "--- Running single-agent benchmark ---"
    SINGLE_RUN_ID=$(date +%s)-single

    cd "$PROJECT_DIR"
    if command -v spring-ai-bench &> /dev/null; then
        spring-ai-bench run "$BENCHMARK" \
            --agent agents/agentfactory-single.yaml \
            2>&1 | tee "$REPORT_DIR/$SINGLE_RUN_ID.log"
    else
        echo "spring-ai-bench CLI not found. Using Maven test runner..."
        mvn -f pom.xml test \
            -Dtest=BenchmarkRunner \
            -Dbenchmark="$BENCHMARK" \
            -Dagent.config=agents/agentfactory-single.yaml \
            2>&1 | tee "$REPORT_DIR/$SINGLE_RUN_ID.log" || true
    fi
    echo "Single-agent run complete: $SINGLE_RUN_ID"
    echo ""
fi

# Run multi-agent benchmark
if [ "$SKIP_MULTI" = false ]; then
    echo "--- Running multi-agent benchmark ---"
    MULTI_RUN_ID=$(date +%s)-multi

    cd "$PROJECT_DIR"
    if command -v spring-ai-bench &> /dev/null; then
        spring-ai-bench run "$BENCHMARK" \
            --agent agents/agentfactory.yaml \
            2>&1 | tee "$REPORT_DIR/$MULTI_RUN_ID.log"
    else
        echo "spring-ai-bench CLI not found. Using Maven test runner..."
        mvn -f pom.xml test \
            -Dtest=BenchmarkRunner \
            -Dbenchmark="$BENCHMARK" \
            -Dagent.config=agents/agentfactory.yaml \
            2>&1 | tee "$REPORT_DIR/$MULTI_RUN_ID.log" || true
    fi
    echo "Multi-agent run complete: $MULTI_RUN_ID"
    echo ""
fi

# Generate comparison summary
echo "========================================"
echo "Comparison Summary"
echo "========================================"
echo ""

# Find the latest result files
SINGLE_RESULT=$(find "$REPORT_DIR" -name "result.json" -path "*single*" -type f 2>/dev/null | sort | tail -1)
MULTI_RESULT=$(find "$REPORT_DIR" -name "result.json" -path "*multi*" -type f 2>/dev/null | sort | tail -1)

if [ -n "$SINGLE_RESULT" ] && [ -n "$MULTI_RESULT" ]; then
    echo "Single-agent result: $SINGLE_RESULT"
    echo "Multi-agent result:  $MULTI_RESULT"
    echo ""

    # Extract key metrics if jq is available
    if command -v jq &> /dev/null; then
        echo "--- Single Agent ---"
        jq '{accuracy, duration, resolvedCount: (.items | map(select(.resolved)) | length), totalItems: (.items | length)}' "$SINGLE_RESULT" 2>/dev/null || echo "(parse error)"
        echo ""
        echo "--- Multi Agent ---"
        jq '{accuracy, duration, resolvedCount: (.items | map(select(.resolved)) | length), totalItems: (.items | length)}' "$MULTI_RESULT" 2>/dev/null || echo "(parse error)"
    else
        echo "Install jq for formatted comparison output"
        echo "Single: $(cat "$SINGLE_RESULT")"
        echo "Multi:  $(cat "$MULTI_RESULT")"
    fi
else
    echo "No result files found yet."
    echo "Run the benchmark first, then check $REPORT_DIR for results."
fi

echo ""
echo "Done. Full reports available in: $REPORT_DIR"
