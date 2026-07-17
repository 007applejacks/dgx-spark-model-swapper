import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders model markdown as chat-sized HTML. react-markdown does NOT execute raw HTML from the
// model (no rehype-raw), so untrusted output can't inject scripts. Styling is scoped to this
// wrapper via arbitrary child selectors, keeping the terminal/mono look but with real structure:
// headings, lists, tables, and code all sized for a narrow bubble, with wide content scrolling
// inside its own box instead of blowing out the chat width.
const MD_CLASS = [
  "min-w-0 break-words text-[13px] leading-relaxed",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2",
  "[&_h1]:mb-1.5 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-bold [&_h1]:text-ink",
  "[&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-bold [&_h2]:text-ink",
  "[&_h3]:mb-1 [&_h3]:mt-2.5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-ink",
  "[&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:text-[13px] [&_h4]:font-semibold [&_h4]:text-ink",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>ul]:my-1 [&_li>ol]:my-1",
  "[&_strong]:font-semibold [&_strong]:text-ink [&_em]:italic",
  "[&_a]:text-cyan [&_a]:underline [&_a]:underline-offset-2",
  "[&_hr]:my-3 [&_hr]:border-line",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-cyan/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted",
  // inline code
  "[&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
  // fenced code block — scrolls horizontally, code inside is unstyled by the inline-code rules
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:leading-relaxed",
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
].join(" ");

// GFM tables can be wider than the bubble — wrap each in its own horizontal scroll container.
const components = {
  table: ({ node: _n, ...props }: { node?: unknown }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]" {...props} />
    </div>
  ),
  th: ({ node: _n, ...props }: { node?: unknown }) => (
    <th className="border border-line bg-panel2 px-2 py-1 text-left font-semibold text-ink" {...props} />
  ),
  td: ({ node: _n, ...props }: { node?: unknown }) => (
    <td className="border border-line px-2 py-1 align-top" {...props} />
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className={MD_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
