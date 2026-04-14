#!/usr/bin/env python3
"""Google Trends keyword research via pytrends.

Usage:
  python google_trends.py --keywords "SEO,keyword research" --geo TW --timeframe "today 12-m" --hl zh-TW

Outputs JSON to stdout.
"""

import argparse
import json
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Google Trends keyword research")
    parser.add_argument("--keywords", required=True, help="Comma-separated keywords")
    parser.add_argument("--geo", default="TW", help="Geographic region (default: TW)")
    parser.add_argument("--timeframe", default="today 12-m", help="Timeframe (default: today 12-m)")
    parser.add_argument("--hl", default="zh-TW", help="Language (default: zh-TW)")
    args = parser.parse_args()

    try:
        from pytrends.request import TrendReq
    except ImportError:
        print(json.dumps({
            "error": "pytrends not installed. Run: pip install pytrends",
            "keywords": []
        }))
        sys.exit(1)

    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if not keywords:
        print(json.dumps({"keywords": []}))
        return

    # Limit to 5 (pytrends max)
    keywords = keywords[:5]

    try:
        pytrends = TrendReq(hl=args.hl, tz=480)  # UTC+8 for Taiwan
        pytrends.build_payload(keywords, geo=args.geo, timeframe=args.timeframe)

        # Interest over time
        interest_df = pytrends.interest_over_time()

        # Related queries
        related = pytrends.related_queries()

        # Suggestions for each keyword
        results = []
        for kw in keywords:
            interest = None
            trend = None

            if not interest_df.empty and kw in interest_df.columns:
                values = interest_df[kw].tolist()
                if values:
                    interest = values[-1]  # Most recent value
                    # Determine trend: compare last 3 months vs prior 3 months
                    if len(values) >= 6:
                        recent = sum(values[-3:]) / 3
                        prior = sum(values[-6:-3]) / 3
                        if prior > 0:
                            change = (recent - prior) / prior
                            if change > 0.1:
                                trend = "rising"
                            elif change < -0.1:
                                trend = "declining"
                            else:
                                trend = "stable"

            related_queries = []
            if kw in related and related[kw]:
                top = related[kw].get("top")
                if top is not None and not top.empty:
                    related_queries = top["query"].tolist()[:10]

            # Get suggestions
            suggestions = []
            try:
                time.sleep(0.5)  # Rate limit
                sugg = pytrends.suggestions(kw)
                suggestions = [s.get("title", "") for s in sugg[:5] if s.get("title")]
            except Exception:
                pass

            results.append({
                "keyword": kw,
                "interest": interest,
                "trend": trend,
                "related_queries": related_queries,
                "suggestions": suggestions,
            })

        print(json.dumps({"keywords": results}, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "keywords": [{
                "keyword": kw,
                "interest": None,
                "trend": None,
                "related_queries": [],
                "suggestions": [],
            } for kw in keywords]
        }))
        sys.exit(0)  # Exit 0 so Node gets the JSON error, not a crash


if __name__ == "__main__":
    main()
