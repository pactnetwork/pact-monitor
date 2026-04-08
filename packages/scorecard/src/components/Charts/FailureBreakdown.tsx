import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const COLORS: Record<string, string> = {
  timeout: "#C9553D",
  error: "#B87333",
  schema_mismatch: "#5A6B7A",
};

export function FailureBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const data = Object.entries(breakdown).map(([key, value]) => ({
    name: key,
    count: value,
  }));

  if (data.length === 0) {
    return <p className="text-neutral-600 text-sm font-mono">No failures recorded</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical">
        <XAxis type="number" tick={{ fill: "#5A6B7A", fontSize: 10 }} />
        <YAxis dataKey="name" type="category" tick={{ fill: "#ccc", fontSize: 11, fontFamily: "JetBrains Mono" }} width={120} />
        <Tooltip
          contentStyle={{ background: "#1A1917", border: "1px solid #333330", color: "#ccc", fontFamily: "JetBrains Mono", fontSize: 12 }}
        />
        <Bar dataKey="count">
          {data.map((entry) => (
            <Cell key={entry.name} fill={COLORS[entry.name] || "#5A6B7A"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
