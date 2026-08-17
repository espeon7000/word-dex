import { useMemo, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
  type TextStyle,
} from "react-native";

import { Fonts, Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// A review longer than this many lines gets clamped, with a "see more" to
// expand it (and "see less" to re-collapse).
const REVIEW_COLLAPSED_LINES = 5;

const SEE_MORE_LABEL = "see more";

// Collapses runs of 3+ newlines down to exactly 2 (ie. at most one blank
// line between paragraphs) - N consecutive newlines render as N-1 blank
// lines, so mashing enter a few times while writing a review would
// otherwise reproduce that many blank lines verbatim. Trailing whitespace
// (including trailing newlines) is dropped entirely, same reasoning - it
// otherwise renders as dead space at the end of the text, pushing the
// inline "see more"/"see less" span down onto its own line instead of
// flowing right after the last real character.
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function ExpandableReviewText({
  text,
  textStyle,
}: {
  text: string;
  // Overrides styles.text's own paddingLeft - RatingPrompt's past-review
  // list (this component's original home) wanted that inset to line up
  // with its own score pill/date row, but a caller with a differently-laid-
  // out header (eg. the explore feed, whose username sits flush left) needs
  // to override it to actually align, rather than inheriting a mismatch.
  textStyle?: TextStyle;
}) {
  const theme = useTheme();
  const displayText = useMemo(() => collapseBlankLines(text), [text]);
  // The review's true (unclamped) line breaks, from an invisible measuring
  // pass below - a numberOfLines-limited Text only ever reports the lines it
  // actually rendered (up to the clamp), so it can't tell us how the text
  // would have wrapped past that point, which is what we need to rebuild
  // the last visible line with room for "see more" carved out of it.
  const [measuredLines, setMeasuredLines] = useState<
    TextLayoutEventData["lines"] | null
  >(null);
  // The pixel width actually available for each line, and the pixel width
  // ".. see more" itself renders at - both from invisible measuring passes
  // below. Real widths (rather than a character-count proxy) matter because
  // this font's monospace-ness isn't perfectly uniform across punctuation
  // like em dashes and curly quotes, and "see more" renders at a different
  // font size than the body text - a per-character budget would misjudge
  // exactly the tight-fit cases this exists to get right.
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [suffixWidth, setSuffixWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isTruncated =
    measuredLines != null && measuredLines.length > REVIEW_COLLAPSED_LINES;

  // The first REVIEW_COLLAPSED_LINES lines exactly as they wrapped, except
  // the last one gets ".. " (only preceded by a character-level trim if it
  // actually needs one) to leave room for "see more" tacked on - rebuilding
  // it this way (rather than reserving space on every line via padding)
  // keeps lines 1..N-1 at their natural width. The ".. " always appears
  // here (never just a bare space) since reaching this branch at all means
  // there's more review beyond what's shown, regardless of whether this
  // particular line's own text needed trimming to fit the label. ".. " is
  // plain (unstyled) so the underlined "see more" span itself doesn't pick
  // up any blank space before its letters.
  const collapsedText = useMemo(() => {
    if (
      !isTruncated ||
      measuredLines == null ||
      containerWidth == null ||
      suffixWidth == null
    ) {
      return null;
    }
    const lines = measuredLines.slice(0, REVIEW_COLLAPSED_LINES);
    const lastIndex = lines.length - 1;
    const lastLine = lines[lastIndex];
    const text = lines.map((l) => l.text);
    // containerWidth is the measured box's own width, which (unlike
    // lastLine.width, a rendered glyph run) includes its paddingLeft.
    const paddingLeft =
      (textStyle?.paddingLeft as number | undefined) ?? Spacing.one;
    const available = containerWidth - paddingLeft - lastLine.width;
    if (available >= suffixWidth) {
      text[lastIndex] = lastLine.text + ".. ";
    } else {
      // lastLine.width / lastLine.text.length is this specific line's own
      // observed width-per-character - a first guess at how many
      // characters to shed to close the gap, refined below by backing up
      // to the nearest word boundary rather than trusting it exactly.
      const avgCharWidth = lastLine.width / lastLine.text.length;
      const guess = Math.ceil((suffixWidth - available) / avgCharWidth) + 1;
      const budgeted = lastLine.text.slice(0, -guess);
      const wordBoundary = budgeted.lastIndexOf(" ");
      const wordSafe =
        wordBoundary > 0 ? budgeted.slice(0, wordBoundary) : budgeted;
      text[lastIndex] = wordSafe.trimEnd() + ".. ";
    }
    return text.join("\n");
  }, [isTruncated, measuredLines, containerWidth, suffixWidth]);

  return (
    <View>
      <Text
        style={[styles.text, styles.measure, textStyle]}
        pointerEvents="none"
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        onTextLayout={(e: NativeSyntheticEvent<TextLayoutEventData>) => {
          if (measuredLines == null) {
            setMeasuredLines(e.nativeEvent.lines);
          }
        }}
      >
        {displayText}
      </Text>
      <Text
        style={[styles.plainSuffix, styles.measureInline]}
        pointerEvents="none"
        onLayout={(e) => setSuffixWidth(e.nativeEvent.layout.width)}
      >
        {".. "}
        <Text style={styles.seeMoreInline}>{SEE_MORE_LABEL}</Text>
      </Text>
      <Text
        style={[styles.text, { color: theme.text }, textStyle]}
        numberOfLines={expanded ? undefined : REVIEW_COLLAPSED_LINES}
      >
        {expanded || !isTruncated ? displayText : collapsedText}
        {!expanded && isTruncated && (
          <Text
            style={[styles.seeMoreInline, { color: theme.textSecondary }]}
            onPress={() => setExpanded(true)}
            suppressHighlighting
          >
            {SEE_MORE_LABEL}
          </Text>
        )}
        {expanded && isTruncated && (
          // Nested the same way "see more" is above - flows onto the end
          // of the last line when there's room, and only wraps onto its
          // own line when there genuinely isn't, instead of a block-level
          // element below the text always forcing a new line. The leading
          // spacer is its own plain (unstyled) span, not part of the
          // underlined one - underlining it too made the underline visibly
          // extend under blank space before the word.
          <>
            {" "}
            <Text
              style={[styles.seeMoreInline, { color: theme.textSecondary }]}
              onPress={() => setExpanded(false)}
              suppressHighlighting
            >
              see less
            </Text>
          </>
        )}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  text: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: Fonts?.mono,
    paddingLeft: Spacing.one,
  },
  // Matches styles.text's font, but (unlike it) unpadded - it's measuring
  // the ".. " that flows inline mid-paragraph, not a paragraph of its own.
  plainSuffix: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
  },
  // Renders the full (unclamped) review off-screen, purely so onTextLayout
  // can report its true line breaks - see the comment above.
  measure: {
    position: "absolute",
    left: 0,
    right: 0,
    opacity: 0,
  },
  // Off-screen copy of just ".. see more", to measure its own rendered
  // width - unlike `measure`, this must NOT be stretched via left/right:0,
  // since that would force it to the container's width instead of its own.
  measureInline: {
    position: "absolute",
    opacity: 0,
  },
  // Shared by both the inline "see more" and "see less" spans, so they
  // read as the same link style.
  seeMoreInline: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
    textDecorationLine: "underline",
  },
});
