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
const REVIEW_COLLAPSED_LINES = 6;

// A non-breaking space (U+00A0), not a plain " ", between "see" and
// "more"/"less" - a plain space is still a valid line-break point, so it
// would let RN split eg. "see" onto one line and "more" onto the next. The
// non-breaking space keeps the whole label atomic: it moves to the next
// line as a unit when it doesn't fit, never splitting mid-label.
const SEE_MORE_LABEL = "see more";
const SEE_LESS_LABEL = "see less";

// Collapses runs of 3+ newlines down to exactly 2 (ie. at most one blank
// line between paragraphs) - N consecutive newlines render as N-1 blank
// lines, so mashing enter a few times while writing a review would
// otherwise reproduce that many blank lines verbatim. Trailing whitespace
// (including trailing newlines) is dropped entirely, same reasoning.
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
  const paddingLeft = (textStyle?.paddingLeft as number | undefined) ?? Spacing.one;
  // The Text's own rendered box width, from the outer View's onLayout - used
  // below (with paddingLeft subtracted) as the true available glyph width,
  // instead of estimating "how many characters fit" from the longest of the
  // kept lines. That estimate undercounts whenever every one of those lines
  // happens to break a little early on a word boundary (each line packs to
  // *a* word boundary, not necessarily to the true edge), which visibly
  // over-trimmed the last line before "see more" - see PR history/the
  // screenshot that flagged it.
  const [containerWidth, setContainerWidth] = useState(0);

  // The review's true (unclamped) line breaks, from an invisible measuring
  // pass below - kept live (not "measure once"), so a later layout pass
  // reporting something different (eg. width settling in two passes) just
  // self-corrects instead of locking in a possibly-stale reading.
  //
  // collapsedText below takes lines 1..N-1 WHOLE and verbatim from this - no
  // per-character trimming/guessing - so collapsing can never alter or drop
  // any of THEIR content, only hide the lines past the cutoff (the same
  // guarantee numberOfLines itself gives). Only the very last kept line ever
  // gets shortened, and only by whole words backed off from a real word
  // boundary, to free up room for "see more" to flow onto its end - see
  // collapsedText's own comment for why that's worth doing by hand instead
  // of just using numberOfLines directly.
  const [measuredLines, setMeasuredLines] = useState<
    TextLayoutEventData["lines"] | null
  >(null);
  const [expanded, setExpanded] = useState(false);
  // Nested Text has no Pressable-style `({pressed}) => ...` render prop, so
  // the dim-on-press feedback (same treatment as explore.tsx's own
  // usernamePressed) is tracked by hand via onPressIn/onPressOut instead -
  // suppressHighlighting above already kills the native OS flash, this is
  // what replaces it.
  const [seeMorePressed, setSeeMorePressed] = useState(false);

  const isTruncated =
    measuredLines != null && measuredLines.length > REVIEW_COLLAPSED_LINES;

  // "see more" flows inline after the last visible line whenever there's
  // room, only dropping to its own line when there genuinely isn't - see
  // the JSX below, which appends it as a nested span right after this text.
  // Since a naturally-wrapped line is already packed as full as it can be
  // (that's why it broke there for the *original*, longer text), the last
  // kept line almost never has slack on its own - so this shortens it,
  // backing off to the nearest word boundary, until there's room for
  // "see more" (plus the one joining space) after it. This only ever
  // affects how much of THIS ONE (already-hidden-behind-"see more") line
  // shows before the cutoff - lines before it are untouched, and the
  // expanded view always shows the complete, unaltered text regardless.
  //
  // Room is worked out in characters, calibrated from real measured pixels -
  // safe to convert between the two specifically because this is a
  // monospace font (every glyph, including the ones in "see more" itself,
  // has the exact same advance width), so one line's own width ÷ its own
  // character count gives an exact per-character width, not an estimate.
  // That's then divided into the real available content width (the Text's
  // own measured box width minus its paddingLeft) to get the true per-line
  // character capacity - not "the longest of the kept lines' own character
  // counts," which undercounts whenever every one of those lines happens to
  // break a little early on a word boundary (each one packs to *a* word
  // boundary, not necessarily all the way to the true edge - see PR
  // history/the screenshot that flagged the last line getting trimmed more
  // than it needed to be).
  const collapsedText = useMemo(() => {
    if (!isTruncated || measuredLines == null) return null;
    const lines = measuredLines.slice(0, REVIEW_COLLAPSED_LINES).map((l) => l.text);
    const lastIndex = lines.length - 1;
    // A wrapped line's own reported text can include the trailing space it
    // broke on (RN's wrap point often lands right after that space, not
    // before it) - trimmed here so it doesn't stack with the JSX's own
    // single joining space below and print as a visible double space before
    // "see more"/"see less".
    let lastLine = lines[lastIndex].trimEnd();
    const maxLineChars = Math.max(...lines.map((l) => l.length));
    // A non-empty measured line to calibrate pixels-per-character from -
    // any one works equally well in a monospace font, so just the first
    // non-blank line is fine.
    const calibrationLine = measuredLines.find((l) => l.text.length > 0);
    const pixelsPerChar =
      calibrationLine && calibrationLine.width > 0
        ? calibrationLine.width / calibrationLine.text.length
        : 0;
    const contentWidth = containerWidth - paddingLeft;
    const charsPerLine =
      pixelsPerChar > 0 && contentWidth > 0
        ? Math.floor(contentWidth / pixelsPerChar)
        : maxLineChars; // no layout width yet - fall back to the old estimate
    const seeMoreChars = 1 + SEE_MORE_LABEL.length; // +1 for the joining space
    if (lastLine.length + seeMoreChars > charsPerLine) {
      const budget = charsPerLine - seeMoreChars;
      const truncated = budget > 0 ? lastLine.slice(0, budget) : "";
      const wordBoundary = truncated.lastIndexOf(" ");
      // Prefer backing off to a full word; only cut mid-word (keeping the
      // hard-truncated fragment as-is) when there's no space to back off to
      // at all - eg. one long continuous word/URL. Either way the render
      // side always joins with exactly one space (see the nested Text's own
      // children below), so this never needs to add one itself.
      lastLine = wordBoundary > 0 ? truncated.slice(0, wordBoundary) : truncated;
    }
    lines[lastIndex] = lastLine;
    return lines.join("\n");
  }, [isTruncated, measuredLines, containerWidth, paddingLeft]);

  return (
    <View onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      <Text
        style={[styles.text, styles.measure, textStyle]}
        pointerEvents="none"
        onTextLayout={(e: NativeSyntheticEvent<TextLayoutEventData>) =>
          setMeasuredLines(e.nativeEvent.lines)
        }
      >
        {displayText}
      </Text>
      <Text
        style={[styles.text, { color: theme.text }, textStyle]}
        // Defensive, not what does the real truncating - collapsedText plus
        // the appended suffix is already built to land within
        // REVIEW_COLLAPSED_LINES (see its own comment), but this still caps
        // the worst case (the character-budget estimate landing slightly
        // short) at exactly that many lines instead of one more, and avoids
        // a flash of the full, un-clamped text before the very first
        // onTextLayout has even fired.
        numberOfLines={expanded ? undefined : REVIEW_COLLAPSED_LINES}
      >
        {expanded || !isTruncated ? displayText : collapsedText}
        {isTruncated && (
          <>
            {/* Plain, unstyled joining space - kept out of the underlined
                nested Text below so the underline itself starts at "see",
                not one character early under this space. */}
            {" "}
            <Text
              style={[
                styles.seeMoreInline,
                { color: theme.textSecondary },
                seeMorePressed && styles.seeMorePressed,
              ]}
              onPress={() => setExpanded((e) => !e)}
              onPressIn={() => setSeeMorePressed(true)}
              onPressOut={() => setSeeMorePressed(false)}
              suppressHighlighting
            >
              {expanded ? SEE_LESS_LABEL : SEE_MORE_LABEL}
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
  // Renders the full (unclamped) review off-screen, purely so onTextLayout
  // can report its true line breaks - see the comment above.
  measure: {
    position: "absolute",
    left: 0,
    right: 0,
    opacity: 0,
  },
  // Nested inline Text, not a block-level sibling - RN scopes a nested
  // Text's own touch handling to its actual rendered glyph run, not the
  // full row width, so this doesn't need its own Pressable/hit-area fix the
  // way a standalone line below the paragraph would.
  seeMoreInline: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
    textDecorationLine: "underline",
  },
  seeMorePressed: {
    opacity: 0.5,
  },
});
