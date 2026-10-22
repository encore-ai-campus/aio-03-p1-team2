import { formatFullDate } from '../../shared/utils/formatDate.js'

export default function AccountsTable({ users, busy, onUpdate }) {
  if (!users.length) return <p className="empty">등록된 사용자가 없어요.</p>
  return (
    <div className="accounts-table-wrap panel">
      <table className="accounts-table">
        <thead>
          <tr>
            <th>이메일</th>
            <th>닉네임</th>
            <th>권한</th>
            <th>상태</th>
            <th>가입일</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <strong>{user.email || '이메일 없음'}</strong>
                <small>{user.id}</small>
              </td>
              <td>{user.display_name || '닉네임 없음'}</td>
              <td>
                <select
                  aria-label={`${user.email || user.id} 권한`}
                  value={user.role}
                  disabled={busy}
                  onChange={(event) => onUpdate(user, 'role', event.target.value)}
                >
                  <option value="user">사용자</option>
                  <option value="admin">관리자</option>
                </select>
              </td>
              <td>
                <select
                  aria-label={`${user.email || user.id} 상태`}
                  value={user.status}
                  disabled={busy}
                  onChange={(event) => onUpdate(user, 'status', event.target.value)}
                >
                  <option value="active">활성</option>
                  <option value="inactive">비활성</option>
                </select>
              </td>
              <td>{formatFullDate(user.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
