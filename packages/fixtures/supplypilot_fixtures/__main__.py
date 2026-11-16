"""Command line entry point: python -m supplypilot_fixtures --out <dir>."""

import argparse
import sys
from datetime import date

from .generator import DEFAULT_REFERENCE_DATE, DEFAULT_SEED, generate, validate, write_fixture_set


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate synthetic SupplyPilot fixtures.")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--reference-date", type=date.fromisoformat, default=DEFAULT_REFERENCE_DATE)
    args = parser.parse_args(argv)

    data = generate(args.seed, args.reference_date)
    problems = validate(data)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    paths = write_fixture_set(data, args.out)
    print(f"Wrote {len(paths)} files to {args.out} (fixture_version {data['manifest']['fixture_version']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
