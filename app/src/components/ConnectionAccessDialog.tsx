/**
 * Who may use a database connection (rfcs/data-source-access.md).
 *
 * Open: anyone in the workspace, as before. Restricted: only the workspace
 * owner and the people listed, each able to read, write (creating tables
 * included) or manage (change this list, the credentials, delete it).
 * Admins have no say unless they are listed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { Lock, Users, X } from "lucide-react";
import {
  useSchemaStore,
  type ConnectionAccess,
  type ConnectionAccessEntry,
  type ConnectionAccessLevel,
} from "../store/schemaStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import type { WorkspaceMember } from "../lib/workspace-client";

type Level = ConnectionAccessLevel;
type Entry = ConnectionAccessEntry;
type AccessState = ConnectionAccess;

const LEVEL_LABEL: Record<Level, string> = {
  read: "Can read",
  write: "Can write",
  manage: "Can manage",
};

const userIdOf = (principal: string) => principal.replace(/^user:/, "");

export default function ConnectionAccessDialog({
  open,
  onClose,
  onSaved,
  connectionId,
  connectionName,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  connectionId: string;
  connectionName: string;
}) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const getConnectionAccess = useSchemaStore(s => s.getConnectionAccess);
  const setConnectionAccess = useSchemaStore(s => s.setConnectionAccess);

  const [loaded, setLoaded] = useState<AccessState | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const data = await getConnectionAccess(workspaceId, connectionId);
      setLoaded(data);
      setRestricted(data.restricted);
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, connectionId, getConnectionAccess]);

  useEffect(() => {
    if (!open) return;
    void load();
    void loadMembers?.();
  }, [open, load, loadMembers]);

  const memberById = useMemo(
    () => new Map(members.map(m => [m.userId, m])),
    [members],
  );
  const listed = useMemo(
    () => new Set(entries.map(e => userIdOf(e.principal))),
    [entries],
  );
  const addable = useMemo(
    () => members.filter(m => m.role !== "owner" && !listed.has(m.userId)),
    [members, listed],
  );
  const canManage = loaded?.canManage ?? false;
  const owner = members.find(m => m.role === "owner");

  const save = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      await setConnectionAccess(workspaceId, connectionId, {
        restricted,
        entries: restricted ? entries : [],
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const label = (m: WorkspaceMember | undefined, principal: string) =>
    m?.email ?? userIdOf(principal);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        Who can use {connectionName}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: "absolute", right: 12, top: 12 }}
        >
          <X size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}

          <ToggleButtonGroup
            exclusive
            size="small"
            value={restricted ? "restricted" : "open"}
            disabled={!canManage}
            onChange={(_, value) => {
              if (!value) return;
              setRestricted(value === "restricted");
            }}
          >
            <ToggleButton value="open" sx={{ gap: 1, textTransform: "none" }}>
              <Users size={16} /> Anyone in the workspace
            </ToggleButton>
            <ToggleButton
              value="restricted"
              sx={{ gap: 1, textTransform: "none" }}
            >
              <Lock size={16} /> Only people listed
            </ToggleButton>
          </ToggleButtonGroup>

          {!restricted && (
            <Typography variant="body2" color="text.secondary">
              Everyone in the workspace can query this connection, as today.
            </Typography>
          )}

          {restricted && (
            <>
              <Typography variant="body2" color="text.secondary">
                People not listed can't see it, its tables, or run the consoles
                and apps that use it. Admins can't either, unless they're
                listed.
              </Typography>

              {owner && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {owner.email}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Owner, always manages
                  </Typography>
                </Box>
              )}

              {entries.map(entry => {
                const id = userIdOf(entry.principal);
                const isMe = id === user?.id;
                return (
                  <Box
                    key={entry.principal}
                    sx={{ display: "flex", alignItems: "center", gap: 1 }}
                  >
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {label(memberById.get(id), entry.principal)}
                      {isMe ? " (you)" : ""}
                    </Typography>
                    <Select
                      size="small"
                      value={entry.level}
                      disabled={!canManage}
                      onChange={e =>
                        setEntries(list =>
                          list.map(x =>
                            x.principal === entry.principal
                              ? { ...x, level: e.target.value as Level }
                              : x,
                          ),
                        )
                      }
                    >
                      {(Object.keys(LEVEL_LABEL) as Level[]).map(level => (
                        <MenuItem key={level} value={level}>
                          {LEVEL_LABEL[level]}
                        </MenuItem>
                      ))}
                    </Select>
                    {canManage && (
                      <IconButton
                        aria-label={`Remove ${label(memberById.get(id), entry.principal)}`}
                        size="small"
                        onClick={() =>
                          setEntries(list =>
                            list.filter(x => x.principal !== entry.principal),
                          )
                        }
                      >
                        <X size={16} />
                      </IconButton>
                    )}
                  </Box>
                );
              })}

              {canManage && (
                <Autocomplete
                  size="small"
                  options={addable}
                  getOptionLabel={m => m.email}
                  value={null}
                  onChange={(_, m) => {
                    if (!m) return;
                    setEntries(list => [
                      ...list,
                      { principal: `user:${m.userId}`, level: "read" },
                    ]);
                  }}
                  renderInput={params => (
                    <TextField {...params} placeholder="Add a person" />
                  )}
                />
              )}
            </>
          )}

          {loaded && !canManage && (
            <Alert severity="info">
              {loaded.level
                ? `You ${LEVEL_LABEL[loaded.level].toLowerCase()}. Only this connection's managers can change who uses it.`
                : "Only this connection's managers can change who uses it."}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{canManage ? "Cancel" : "Close"}</Button>
        {canManage && (
          <Button variant="contained" onClick={save} disabled={saving}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
