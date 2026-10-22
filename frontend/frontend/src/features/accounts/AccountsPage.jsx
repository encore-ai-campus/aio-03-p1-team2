import PageHeading from '../../shared/components/PageHeading.jsx'
import Pagination from '../../shared/components/Pagination.jsx'
import ResourceState from '../../shared/components/ResourceState.jsx'
import { useNavigationLock } from '../../shared/hooks/useNavigationLock.js'
import { useAccounts } from './useAccounts.js'
import AccountsTable from './AccountsTable.jsx'
import './accounts.css'

export default function AccountsPage({ client, onUnauthorized, onBusyChange }) {
  const accounts = useAccounts(client, onUnauthorized)
  useNavigationLock(accounts.busy, onBusyChange)
  return (
    <div className="accounts-page">
      <PageHeading title="계정 관리" description="사용자 권한과 계정 상태를 관리해요." />
      <p className="accounts-summary muted">
        전체 사용자{accounts.data ? ` · ${accounts.data.total}명` : ''}
        {accounts.loading && accounts.data && <span role="status"> · 최신 내용 확인 중…</span>}
      </p>
      <p role="status">{accounts.message}</p>
      {accounts.actionError && (
        <p className="form-error alert-box" role="alert">
          {accounts.actionError}
        </p>
      )}
      <ResourceState
        loading={accounts.loading}
        error={accounts.error}
        onRetry={accounts.refresh}
        hasData={Boolean(accounts.data)}
      >
        <AccountsTable
          users={accounts.data?.items || []}
          busy={accounts.busy}
          onUpdate={accounts.update}
        />
        <Pagination
          total={accounts.data?.total || 0}
          offset={accounts.offset}
          pageSize={accounts.pageSize}
          busy={accounts.busy}
          onChange={accounts.setOffset}
          label="사용자 목록 페이지"
        />
      </ResourceState>
    </div>
  )
}
