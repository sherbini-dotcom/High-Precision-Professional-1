export function saveSession(roomCode: string, sessionToken: string, role: string, name: string, memberId: number): void {
  localStorage.setItem(`wp_session_${roomCode}`, sessionToken);
  localStorage.setItem(`wp_role_${roomCode}`, role);
  localStorage.setItem(`wp_name_${roomCode}`, name);
  localStorage.setItem(`wp_memberId_${roomCode}`, String(memberId));
}

export function getSession(roomCode: string): { sessionToken: string; role: string; name: string; memberId: number } | null {
  const sessionToken = localStorage.getItem(`wp_session_${roomCode}`);
  const role = localStorage.getItem(`wp_role_${roomCode}`);
  const name = localStorage.getItem(`wp_name_${roomCode}`);
  const memberId = localStorage.getItem(`wp_memberId_${roomCode}`);
  if (!sessionToken || !role || !name || !memberId) return null;
  return { sessionToken, role, name, memberId: parseInt(memberId, 10) };
}

export function clearSession(roomCode: string): void {
  localStorage.removeItem(`wp_session_${roomCode}`);
  localStorage.removeItem(`wp_role_${roomCode}`);
  localStorage.removeItem(`wp_name_${roomCode}`);
  localStorage.removeItem(`wp_memberId_${roomCode}`);
}
