import { TriangleAlert } from 'lucide-react';
import { Page } from '../components/layout';
import { Group, Row, Loading, Pill, AppGlyph } from '../components/ui';
import { useInfo, useMeta, useHost } from '../lib/docker';
import { bytes, mem, duration, date } from '../lib/format';

export function SystemView() {
  const { data: info, isLoading } = useInfo();
  const { data: meta } = useMeta();
  const { data: host } = useHost();
  if (isLoading || !info) return <Page title="Engine"><Loading /></Page>;
  const v = meta?.engine || {};
  const comp = (name: string) => v.Components?.find((c: any) => c.Name === name);
  const plugins = info.Plugins || {};

  return (
    <Page title="Engine" subtitle={`${v.Platform?.Name || 'Docker Engine'} ${info.ServerVersion}`}>
      <div className="scroll pad">
        <div className="about card">
          <AppGlyph size={64} />
          <div>
            <div className="about-title">Docker Inspector <span className="muted">v{meta?.app.version}</span></div>
            <div className="muted small">Connected to <span className="mono">{meta?.socket}</span> · API v{meta?.apiVersion}</div>
          </div>
        </div>

        {(info.Warnings || []).length > 0 && (
          <Group title="Warnings">
            {info.Warnings.map((w: string, i: number) => <div key={i} className="warning-row"><TriangleAlert size={14} className="tint-orange" /> {w}</div>)}
          </Group>
        )}

        <div className="columns">
          <div className="col">
            <Group title="Engine">
              <Row label="Version">{info.ServerVersion}</Row>
              <Row label="API version">{v.ApiVersion} <span className="muted">(min {v.MinAPIVersion})</span></Row>
              <Row label="Go version">{v.GoVersion}</Row>
              <Row label="Git commit" mono>{v.GitCommit}</Row>
              <Row label="Built">{date(v.BuildTime)}</Row>
              <Row label="Experimental">{v.Experimental ? 'Yes' : 'No'}</Row>
              <Row label="Engine ID" mono copy={info.ID}>{info.ID?.slice(0, 24)}…</Row>
              <Row label="Live restore">{info.LiveRestoreEnabled ? 'Enabled' : 'Disabled'}</Row>
              <Row label="Root directory" mono>{info.DockerRootDir}</Row>
              <Row label="Debug">{info.Debug ? 'On' : 'Off'}</Row>
            </Group>
            <Group title="Components">
              {(v.Components || []).map((c: any) => <Row key={c.Name} label={c.Name}>{c.Version}{c.Details?.GitCommit ? <span className="muted mono small"> {c.Details.GitCommit.slice(0, 10)}</span> : null}</Row>)}
              {!comp('containerd') && info.ContainerdCommit && <Row label="containerd" mono>{info.ContainerdCommit.ID}</Row>}
            </Group>
            <Group title="Storage & Runtime">
              <Row label="Storage driver">{info.Driver}</Row>
              {(info.DriverStatus || []).map(([k, val]: [string, string]) => <Row key={k} label={k}>{val}</Row>)}
              <Row label="Logging driver">{info.LoggingDriver}</Row>
              <Row label="Cgroup">{info.CgroupDriver} · v{info.CgroupVersion}</Row>
              <Row label="Default runtime">{info.DefaultRuntime}</Row>
              <Row label="Runtimes">{Object.keys(info.Runtimes || {}).join(', ')}</Row>
              <Row label="Init binary">{info.InitBinary}</Row>
              <Row label="Isolation">{info.Isolation || 'default'}</Row>
            </Group>
          </div>
          <div className="col">
            <Group title="Host">
              <Row label="Name">{info.Name}</Row>
              <Row label="Operating system">{info.OperatingSystem}</Row>
              <Row label="Kernel">{info.KernelVersion}</Row>
              <Row label="Architecture">{info.Architecture}</Row>
              <Row label="CPUs">{String(info.NCPU)}{host ? ` · ${host.cpuModel}` : ''}</Row>
              <Row label="Memory">{mem(info.MemTotal)}</Row>
              {host && <Row label="Uptime">{duration(host.uptime)}</Row>}
              {host?.disk && <Row label="Disk free">{bytes(host.disk.free)} of {bytes(host.disk.total)}</Row>}
              <Row label="Swap limit support">{info.SwapLimit ? 'Yes' : 'No'}</Row>
              <Row label="Memory limit support">{info.MemoryLimit ? 'Yes' : 'No'}</Row>
              <Row label="CPU CFS quota">{info.CpuCfsQuota ? 'Yes' : 'No'}</Row>
              <Row label="OOM kill disable">{info.OomKillDisable ? 'Yes' : 'No'}</Row>
              <Row label="IPv4 forwarding">{info.IPv4Forwarding ? 'Enabled' : 'Disabled'}</Row>
            </Group>
            <Group title="Objects">
              <Row label="Containers">{info.Containers} <span className="muted">({info.ContainersRunning} running, {info.ContainersPaused} paused, {info.ContainersStopped} stopped)</span></Row>
              <Row label="Images">{String(info.Images)}</Row>
            </Group>
            <Group title="Plugins">
              <Row label="Volume">{(plugins.Volume || []).join(', ')}</Row>
              <Row label="Network">{(plugins.Network || []).join(', ')}</Row>
              <Row label="Log">{(plugins.Log || []).join(', ')}</Row>
              <Row label="Authorization">{(plugins.Authorization || []).join(', ') || 'None'}</Row>
            </Group>
            <Group title="Security">
              {(info.SecurityOptions || []).map((s: string) => <Row key={s} label={s.split(',')[0].replace('name=', '')} mono>{s.split(',').slice(1).join(', ') || 'enabled'}</Row>)}
            </Group>
            <Group title="Registry & Network">
              <Row label="Index server" mono>{info.IndexServerAddress}</Row>
              <Row label="Mirrors" mono>{(info.RegistryConfig?.Mirrors || []).join(', ') || 'None'}</Row>
              <Row label="Insecure registries" mono>{(info.RegistryConfig?.InsecureRegistryCIDRs || []).join(', ')}</Row>
              <Row label="HTTP proxy" mono>{info.HttpProxy}</Row>
              <Row label="HTTPS proxy" mono>{info.HttpsProxy}</Row>
              <Row label="No proxy" mono>{info.NoProxy}</Row>
              <Row label="Default address pools" mono>{(info.DefaultAddressPools || []).map((p: any) => `${p.Base}/${p.Size}`).join(', ')}</Row>
              <Row label="Swarm"><Pill color={info.Swarm?.LocalNodeState === 'active' ? 'green' : 'gray'}>{info.Swarm?.LocalNodeState || 'inactive'}</Pill></Row>
            </Group>
          </div>
        </div>
      </div>
    </Page>
  );
}
