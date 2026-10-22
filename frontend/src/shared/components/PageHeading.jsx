export default function PageHeading({ title, description }) {
  return (
    <div className="dashboard-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
    </div>
  )
}
