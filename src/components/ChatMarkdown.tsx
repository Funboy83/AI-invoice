"use client";

import Link from "next/link";
import clsx from "clsx";
import { isNumericCell, parseBlocks, parseInline } from "@/lib/chat/markdown";

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.type === "bold" ? (
          <strong key={i} className="font-semibold">
            {part.text}
          </strong>
        ) : part.type === "link" ? (
          <Link key={i} href={part.href} className="font-medium text-indigo-600 underline underline-offset-2">
            {part.text}
          </Link>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

/** An AI reply: text, headings, bullet lists and real tables for lists of records, so numbers line up and are easy to read on a phone. */
export default function ChatMarkdown({ content, mobile }: { content: string; mobile: boolean }) {
  return (
    <div className="space-y-2">
      {parseBlocks(content).map((block, i) =>
        block.type === "text" ? (
          <div key={i} className="whitespace-pre-wrap">
            <InlineText text={block.text} />
          </div>
        ) : block.type === "heading" ? (
          <p key={i} className={clsx("pt-1 font-semibold text-slate-900", mobile ? "text-base" : "text-sm")}>
            <InlineText text={block.text} />
          </p>
        ) : block.type === "list" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {block.items.map((item, k) => (
              <li key={k}>
                <InlineText text={item} />
              </li>
            ))}
          </ul>
        ) : (
          // Wide tables scroll sideways inside the bubble instead of squashing columns.
          <div key={i} className="-mx-1 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className={clsx("w-full border-collapse whitespace-nowrap", mobile ? "text-[13px]" : "text-xs")}>
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  {block.header.map((h, k) => (
                    <th key={k} className={clsx("px-2 py-1.5 font-semibold border-b border-slate-200", block.align[k] === "right" ? "text-right" : block.align[k] === "center" ? "text-center" : "text-left")}>
                      <InlineText text={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="odd:bg-white even:bg-slate-50/60">
                    {row.map((cell, k) => (
                      <td
                        key={k}
                        className={clsx(
                          "px-2 py-1.5 border-b border-slate-100 text-slate-800",
                          block.align[k] === "center" ? "text-center" : block.align[k] === "right" || isNumericCell(cell) ? "text-right tabular-nums" : "text-left"
                        )}
                      >
                        <InlineText text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
