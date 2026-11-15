import "server-only";
import path from "node:path";
import { Document, Font, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { SecuritySeverity } from "@prisma/client";
import { FINISHED_CHECK_STATUSES, TARGET_KIND_LABEL } from "@/lib/security-checks";
import type { PostedReport, ReportFinding } from "@/lib/security-checks/report";
import { SECURITY_SEVERITIES, SEVERITY_LABEL } from "@/lib/security-severity";

/**
 * The downloadable security report (12 and 14 Nov plans): laid out like a
 * printed Ziki report, in Ziki's colours, with the full detail the page keeps
 * short. It follows the page's rules exactly: "How to fix" only on a finding
 * the client paid to have fixed.
 */

/**
 * The PDF's own font: Inter, the same typeface as the site (app/fonts holds
 * only a web-only latin subset, which a PDF can't use). These are Inter's full
 * desktop files (SIL Open Font License, assets/fonts/Inter-OFL.txt), so
 * Yoruba, Igbo and Hausa letters and ₦ print correctly. next.config.ts ships
 * these files with the PDF route.
 */
const FONT = "Inter";
const fontFile = (name: string) => path.join(process.cwd(), "assets", "fonts", name);
Font.register({
  family: FONT,
  fonts: [
    { src: fontFile("Inter-Regular.ttf"), fontWeight: 400 },
    { src: fontFile("Inter-SemiBold.ttf"), fontWeight: 600 },
    { src: fontFile("Inter-Bold.ttf"), fontWeight: 700 },
    { src: fontFile("Inter-ExtraBold.ttf"), fontWeight: 800 },
  ],
});
Font.registerHyphenationCallback((word) => [word]);

/**
 * Sizes are the page's, as a browser prints them (1 CSS px = 0.75 pt): the
 * headline 28 px, finding titles and headings 16 px, text 14 px, labels and
 * chips 12 px. Colours are Ziki's own tokens (app/globals.css).
 */
const pt = (px: number) => px * 0.75;
const INK = "#15121f"; // --zk-text
const TEXT2 = "#3e4a63"; // --zk-text2
const MUTED = "#5f6577"; // --zk-muted
const LINE = "#e3e8f2"; // --zk-border
const CHIP = "#f0f2f7"; // --zk-chip

/** The severity chips' colours on the page (components/security-finding.css, light theme). */
const SEVERITY_COLOUR: Record<SecuritySeverity, { bg: string; fg: string; border: string }> = {
  critical: { bg: "#ffe2e2", fg: "#82181a", border: "#ffa2a2" },
  high: { bg: "#ffedd4", fg: "#7e2a0c", border: "#ffb86a" },
  medium: { bg: "#fef9c2", fg: "#733e0a", border: "#ffdf20" },
  low: { bg: "#dbeafe", fg: "#1c398e", border: "#8ec5ff" },
};
const CLEAR = { bg: "#e3f6ec", fg: "#146c43", border: "#e3f6ec" }; // --zk-ok-bg / --zk-ok-fg

const styles = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 64, paddingHorizontal: 48, fontSize: pt(14), fontFamily: FONT, color: INK, lineHeight: 20 / 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  brand: { flexDirection: "row", alignItems: "center", gap: 7 },
  brandText: { fontSize: pt(16), fontWeight: 700 },
  meta: { fontSize: pt(12), color: TEXT2, textAlign: "right", lineHeight: 16 / 12 },
  rule: { marginTop: 16, borderBottomWidth: 1.5, borderBottomColor: INK },
  title: { marginTop: 20, fontSize: pt(28), fontWeight: 800, letterSpacing: pt(-0.56), lineHeight: 37.33 / 28 },
  summary: { marginTop: 6, color: TEXT2 },
  tiles: { marginTop: 16, flexDirection: "row", gap: 8 },
  tile: { flex: 1, paddingVertical: 9, paddingHorizontal: 11, borderRadius: 8, borderWidth: 0.75 },
  tileCount: { fontSize: pt(28), fontWeight: 800, lineHeight: 1.1 },
  tileLabel: { marginTop: 2, fontSize: pt(12), fontWeight: 700 },
  // The page's card: 20 px corners, a border, 24 px sides; the header 20 px from the top.
  card: { marginTop: 28, borderWidth: 1, borderColor: LINE, borderRadius: pt(20), overflow: "hidden" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: pt(24), paddingTop: pt(20), paddingBottom: pt(12), borderBottomWidth: 1, borderBottomColor: LINE },
  sectionTitle: { fontSize: pt(16), fontWeight: 600, lineHeight: 24 / 16 },
  sectionSub: { fontSize: pt(12), color: MUTED },
  private: { flexDirection: "row", alignItems: "center", gap: 3, fontSize: pt(12), fontWeight: 600, color: TEXT2 },
  empty: { paddingHorizontal: pt(24), paddingVertical: pt(16), color: TEXT2 },
  cardFoot: { backgroundColor: "#eaf2fe", paddingHorizontal: pt(24), paddingVertical: pt(12) }, // --zk-tint
  clearTitle: { fontSize: pt(12), fontWeight: 700, color: CLEAR.fg },
  // The page's row: a 6rem severity column, a 16 px gap, 16 px above and below.
  finding: { flexDirection: "row", gap: pt(16), paddingVertical: pt(16), paddingHorizontal: pt(24), borderBottomWidth: 1, borderBottomColor: LINE },
  severityColumn: { width: pt(96), alignItems: "flex-start" },
  findingBody: { flex: 1 },
  findingTitle: { fontSize: pt(16), fontWeight: 700, lineHeight: 24 / 16 },
  chip: { borderRadius: 10, borderWidth: 0.75, paddingHorizontal: pt(10), paddingTop: 1.5, paddingBottom: 0.5, fontSize: pt(12), fontWeight: 700 },
  moved: { marginTop: 3, alignSelf: "flex-start", borderRadius: 10, backgroundColor: CHIP, paddingHorizontal: pt(10), paddingTop: 1.5, paddingBottom: 0.5, fontSize: pt(12), fontWeight: 600, color: TEXT2 },
  description: { marginTop: 4, color: TEXT2 },
  howToFix: { marginTop: pt(8) },
  howToFixLabel: { fontWeight: 600 },
  clearGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  clearItem: { width: "50%", flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2.5, color: TEXT2 },
  note: { marginTop: 18, flexDirection: "row", gap: 8, borderWidth: 1, borderColor: LINE, borderRadius: 8, padding: 11, color: TEXT2 },
  footerRow: {
    position: "absolute", bottom: 26, left: 48, right: 48, paddingTop: 8, borderTopWidth: 1, borderTopColor: LINE,
    flexDirection: "row", justifyContent: "space-between", fontSize: pt(12), color: MUTED,
  },
});

/** Problem text is written in Markdown; the PDF prints it as plain text. */
function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, "").trim();
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const FIX_STATE = { fixing: "Being fixed", fixed: "Fixed", closed: "Closed" } as const;

function ZikiMark() {
  return (
    <Svg viewBox="0 0 100 100" width={16} height={16}>
      <Path d="M22 22H78L22 78H78M30 50H70" stroke={INK} strokeWidth={11} fill="none" />
    </Svg>
  );
}

function Tick() {
  return (
    <Svg viewBox="0 0 24 24" width={8} height={8}>
      <Path d="M5 12.5l4.5 4.5L19 7" stroke={CLEAR.fg} strokeWidth={3} fill="none" />
    </Svg>
  );
}

function LockMark() {
  return (
    <Svg viewBox="0 0 24 24" width={10} height={10}>
      <Path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" stroke={TEXT2} strokeWidth={2} fill="none" />
    </Svg>
  );
}

function SeverityPill({ severity }: { severity: SecuritySeverity }) {
  const colour = SEVERITY_COLOUR[severity];
  return <Text style={[styles.chip, { backgroundColor: colour.bg, color: colour.fg, borderColor: colour.border }]}>{SEVERITY_LABEL[severity]}</Text>;
}

/** One finding, laid out like a row of "What we found" on the page: the severity on the left, the rest beside it. */
function Finding({ finding }: { finding: ReportFinding }) {
  return (
    <View style={styles.finding} wrap={false}>
      <View style={styles.severityColumn}>
        <SeverityPill severity={finding.severity} />
      </View>
      <View style={styles.findingBody}>
        <Text style={styles.findingTitle}>{plain(finding.title)}</Text>
        {finding.fix ? (
          <Text style={styles.moved}>
            ↗ Moved to your app{finding.fix.issue ? ` · Issue #${finding.fix.issue.number}` : ""} · {FIX_STATE[finding.fix.bucket]}
          </Text>
        ) : null}
        <Text style={styles.description}>{plain(finding.description)}</Text>
        {finding.howToFix ? (
          <Text style={styles.howToFix}>
            <Text style={styles.howToFixLabel}>How to fix: </Text>
            {plain(finding.howToFix)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ReportDocument({ report, generatedAt }: { report: PostedReport; generatedAt: Date }) {
  const still = !FINISHED_CHECK_STATUSES.has(report.status);
  const site = report.target.value;
  const title =
    report.total === 0
      ? still ? `Nothing found on ${site} yet` : `No problems found on ${site}`
      : `We found ${plural(report.total, "thing")} to fix on ${site}`;
  const date = generatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const tiles = [
    ...SECURITY_SEVERITIES.map((level) => ({ key: level, count: report.counts[level], label: SEVERITY_LABEL[level], colour: SEVERITY_COLOUR[level] })),
    { key: "clear", count: report.clearParts.length, label: "Clear", colour: CLEAR },
  ];

  return (
    <Document title={`Ziki Security report: ${report.target.input}`} author="Ziki">
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <ZikiMark />
            <Text style={styles.brandText}>Ziki Security report</Text>
          </View>
          <View>
            <Text style={styles.meta}>{site} · {TARGET_KIND_LABEL[report.target.kind].toLowerCase()}</Text>
            <Text style={styles.meta}>{date} · {plural(report.progress.total, "check")}{still ? " (still checking)" : ""}</Text>
          </View>
        </View>
        <View style={styles.rule} />

        <Text style={styles.title}>{title}</Text>
        {/* The page keeps one short line; the PDF has Ziki's full summary, else that same line. */}
        <Text style={styles.summary}>
          {report.summary
            ? plain(report.summary)
            : `We checked ${plural(report.progress.total, "part")} of ${site} and found ${report.total ? plural(report.total, "problem") : "no problems"}.`}
        </Text>

        <View style={styles.tiles}>
          {tiles.map((tile) => (
            <View key={tile.key} style={[styles.tile, { backgroundColor: tile.colour.bg, borderColor: tile.colour.border }]}>
              <Text style={[styles.tileCount, { color: tile.colour.fg }]}>{tile.count}</Text>
              <Text style={[styles.tileLabel, { color: tile.colour.fg }]}>{tile.label}</Text>
            </View>
          ))}
        </View>

        {/* "What we found" as on the page: its own card, the findings divided inside, what came back clear at its foot. */}
        <View style={styles.card}>
          <View style={styles.cardHeader} wrap={false}>
            <View>
              <Text style={styles.sectionTitle}>What we found</Text>
              <Text style={styles.sectionSub}>Worst first.</Text>
            </View>
            <View style={styles.private}>
              <LockMark />
              <Text>Private</Text>
            </View>
          </View>
          {report.findings.length ? (
            report.findings.map((finding) => <Finding key={finding.id} finding={finding} />)
          ) : (
            <Text style={styles.empty}>The agents found no problems.</Text>
          )}
          {report.clearParts.length ? (
            <View style={styles.cardFoot} wrap={false}>
              <Text style={styles.clearTitle}>What came back clear</Text>
              <View style={styles.clearGrid}>
                {report.clearParts.map((part) => (
                  <View key={part} style={styles.clearItem}>
                    <Tick />
                    <Text>{plain(part)}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.note} wrap={false}>
          <LockMark />
          <Text style={{ flex: 1 }}>
            Ziki&apos;s agents only looked. Nothing on {site} was changed, logged into or slowed down. Want these fixed for you? Move
            them to your app on Ziki and agents will fix and re-check each one.
          </Text>
        </View>

        <View style={styles.footerRow} fixed>
          <Text>ziki.dev/security</Text>
          <Text>Private: shared only with the person who ran this check</Text>
        </View>
      </Page>
    </Document>
  );
}

/** Only a posted report has a PDF: the type refuses one still in progress outright. */
export function renderReportPdf(report: PostedReport): Promise<Buffer> {
  return renderToBuffer(<ReportDocument report={report} generatedAt={new Date()} />);
}
