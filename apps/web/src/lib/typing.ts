/** "Ada is typing…", "Ada and Ben are typing…", "Several people are typing…". */
export function typingText(names: string[]): { names: string; verb: string } | null {
  if (names.length === 0) return null;
  if (names.length > 3) return { names: "", verb: "Several people are typing…" };
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return { names: joined, verb: names.length === 1 ? " is typing…" : " are typing…" };
}
