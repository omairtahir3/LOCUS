/**
 * The title block every page opens with.
 *
 * Thirteen pages had already written this by hand, and they had drifted: some
 * set `display:flex` inline on top of the class that already sets it, one
 * omitted the description, one used an h2 and another an h1. The markup is the
 * same shape in all of them -- a title, an optional line under it, and
 * optional controls on the right -- so it is one component now.
 *
 * `actions` rather than `children` because the right-hand slot is for controls
 * (a user selector, a Mark all read button), and naming it says so.
 */
export default function PageHeader({ title, description, actions }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
