const folderLabels: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  spam: 'SPAM',
  bin: 'TRASH',
  trash: 'TRASH',
  draft: 'DRAFT',
  drafts: 'DRAFT',
  unread: 'UNREAD',
  starred: 'STARRED',
  important: 'IMPORTANT',
};

export function gmailListQuery(folder: string, query = '', selectedLabels: string[] = []) {
  const name = folder.toLowerCase();
  const label = folderLabels[name];
  const labelIds = [...new Set([...selectedLabels.filter(Boolean), ...(label ? [label] : [])])];
  const search = query.trim();
  const q =
    name === 'archive'
      ? `-in:inbox -in:spam -in:trash -is:draft${search ? ` (${search})` : ''}`
      : search;

  if (!label && !['', 'all', 'allmail', 'all-mail', 'archive'].includes(name)) {
    labelIds.push(folder);
  }

  return {
    q: q || undefined,
    labelIds,
    includeSpamTrash:
      labelIds.some((id) => id === 'SPAM' || id === 'TRASH') ||
      /(?:^|[\s({])in:(?:anywhere|trash|spam)(?:$|[\s)}])/i.test(search),
  };
}
