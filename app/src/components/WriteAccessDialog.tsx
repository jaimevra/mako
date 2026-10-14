import { useEffect, useMemo, useState } from "react";
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
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from "@mui/material";
import { X as RemoveIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useSchemaStore, type Connection } from "../store/schemaStore";
import {
  grantsOn,
  inheritedGrants,
  ROLE_PRINCIPALS,
  type GrantTarget,
} from "../lib/write-grants";

interface WriteAccessDialogProps {
  open: boolean;
  onClose: () => void;
  connection: Connection;
  target: GrantTarget;
}

interface PrincipalOption {
  principal: string;
  label: string;
  detail: string;
}

/**
 * Who may write to one schema or table of a connection, through governed
 * writes (app actions, workflow writes). Consoles and the agent are not
 * affected — see rfcs/governed-writes.md.
 */
export default function WriteAccessDialog({
  open,
  onClose,
  connection,
  target,
}: WriteAccessDialogProps) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const setWriteGrants = useSchemaStore(s => s.setWriteGrants);

  const [principals, setPrincipals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrincipals(
      grantsOn(connection.writeGrants, target).map(g => g.principal),
    );
    setError(null);
    loadMembers().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection.id, target.schema, target.table]);

  const options: PrincipalOption[] = useMemo(
    () => [
      ...ROLE_PRINCIPALS,
      // Viewers never write, so they are not offered.
      ...members
        .filter(m => m.role !== "viewer")
        .map(m => ({
          principal: `user:${m.userId}`,
          label: m.email,
          detail: m.role,
        })),
    ],
    [members],
  );
  const describe = (principal: string): PrincipalOption =>
    options.find(o => o.principal === principal) ?? {
      principal,
      label: principal,
      detail: "",
    };

  const inherited = inheritedGrants(connection.writeGrants, target);
  const targetLabel =
    target.table === "*"
      ? `${target.schema}.*`
      : `${target.schema}.${target.table}`;

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    setError(null);
    try {
      const onTarget = new Set(
        grantsOn(connection.writeGrants, target).map(
          g => `${g.schema}\u0000${g.table}\u0000${g.principal}`,
        ),
      );
      const others = (connection.writeGrants ?? []).filter(
        g => !onTarget.has(`${g.schema}\u0000${g.table}\u0000${g.principal}`),
      );
      await setWriteGrants(currentWorkspace.id, connection.id, [
        ...others.map(({ schema, table, principal }) => ({
          schema,
          table,
          principal,
        })),
        ...principals.map(principal => ({
          schema: target.schema,
          table: target.table,
          principal,
        })),
      ]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save write access");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        Write access
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {connection.displayName} / {targetLabel}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
          {target.table === "*"
            ? "Who can write to every table in this schema"
            : "Who can write to this table"}
        </Typography>
        <Autocomplete
          size="small"
          options={options.filter(o => !principals.includes(o.principal))}
          getOptionLabel={o => o.label}
          renderOption={(props, o) => (
            <li {...props} key={o.principal}>
              <ListItemText primary={o.label} secondary={o.detail} />
            </li>
          )}
          value={null}
          blurOnSelect
          onChange={(_, o) => {
            if (o) setPrincipals(p => [...p, o.principal]);
          }}
          renderInput={params => (
            <TextField
              {...params}
              placeholder="Add people, roles or Workflows…"
            />
          )}
        />
        <List dense>
          {principals.map(principal => {
            const o = describe(principal);
            return (
              <ListItem
                key={principal}
                secondaryAction={
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label={`Remove ${o.label}`}
                    onClick={() =>
                      setPrincipals(p => p.filter(x => x !== principal))
                    }
                  >
                    <RemoveIcon size={16} />
                  </IconButton>
                }
              >
                <ListItemText primary={o.label} secondary={o.detail} />
              </ListItem>
            );
          })}
        </List>

        {inherited.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Inherited from {target.schema}.*
            </Typography>
            <List dense>
              {inherited.map(g => {
                const o = describe(g.principal);
                return (
                  <ListItem key={g.principal}>
                    <ListItemText primary={o.label} secondary={o.detail} />
                  </ListItem>
                );
              })}
            </List>
          </Box>
        )}

        <Typography variant="body2" sx={{ color: "text.secondary", mt: 2 }}>
          Applies to app actions and workflow writes. Nothing else on this
          connection is writable by them. Workspace viewers never write.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          onClick={handleSave}
          disabled={saving}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
