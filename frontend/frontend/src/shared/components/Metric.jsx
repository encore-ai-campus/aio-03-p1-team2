export default function Metric({ label, value }) {
  return (
    <div className="metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  )
}
