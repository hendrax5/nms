import React, { useState } from 'react';

const ReportsEngine = ({ token }) => {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState('30 days');

  const generateReport = () => {
    setLoading(true);
    fetch(`/api/devices/reports/executive?period=${encodeURIComponent(period)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success') {
        setReports(data.data);
      }
      setLoading(false);
    })
    .catch(err => {
      console.error("Failed to fetch reports", err);
      setLoading(false);
    });
  };

  const downloadCSV = () => {
    if (reports.length === 0) return;
    const headers = ["Device ID", "Hostname", "IP Address", "Device Type", "Current Status", "Avg CPU (%)", "Avg Ping (ms)", "SLA Uptime (%)"];
    const rows = reports.map(r => [
      r.id, r.name, r.ip, r.type, r.current_status, r.avg_cpu, r.avg_ping, r.sla_percent
    ]);
    
    const csvContent = "data:text/csv;charset=utf-8," 
        + headers.join(",") + "\n"
        + rows.map(e => e.join(",")).join("\n");
        
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Executive_SLA_Report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ padding: '20px', color: '#f8fafc', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 600 }}>
          <span style={{ fontSize: '24px' }}>📄</span> Executive Reporting Engine
        </h2>
        <div style={{ display: 'flex', gap: '12px' }}>
          <select 
            value={period} 
            onChange={e => setPeriod(e.target.value)}
            style={{ padding: '8px 16px', background: '#1e293b', border: '1px solid #475569', color: '#fff', borderRadius: '6px', outline: 'none', cursor: 'pointer' }}
          >
            <option value="7 days">Last 7 Days</option>
            <option value="30 days">Last 30 Days</option>
            <option value="90 days">Last 90 Days</option>
          </select>
          <button onClick={generateReport} disabled={loading} style={{ padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', transition: '0.2s', opacity: loading ? 0.7 : 1 }} onMouseOver={e=>e.currentTarget.style.background='#2563eb'} onMouseOut={e=>e.currentTarget.style.background='#3b82f6'}>
             {loading ? '⏳ Compiling Data...' : '⚡ Generate SLA Report'}
          </button>
          <button onClick={downloadCSV} disabled={reports.length === 0} style={{ padding: '8px 16px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: reports.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', transition: '0.2s', opacity: reports.length === 0 ? 0.5 : 1 }} onMouseOver={e=>reports.length > 0 && (e.currentTarget.style.background='#059669')} onMouseOut={e=>reports.length > 0 && (e.currentTarget.style.background='#10b981')}>
             📥 Export to CSV (Excel)
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', background: '#0f172a', borderRadius: '8px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)' }}>
        <div style={{ padding: '16px', borderBottom: '1px solid #334155', background: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '15px', color: '#e2e8f0', letterSpacing: '0.5px' }}>Node Availability & Utilization Matrix</h3>
          <span style={{ fontSize: '12px', color: '#94a3b8', background: 'rgba(255,255,255,0.05)', padding: '4px 12px', borderRadius: '12px' }}>Lookback Target: <strong>{period}</strong></span>
        </div>
        
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#1e293b', zIndex: 1, boxShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>
              <tr style={{ color: '#cbd5e1', letterSpacing: '0.05em' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', borderBottom: '1px solid #475569' }}>NO</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', borderBottom: '1px solid #475569' }}>HOSTNAME</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', borderBottom: '1px solid #475569' }}>IP ADDRESS</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', borderBottom: '1px solid #475569' }}>DEVICE TYPE</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', borderBottom: '1px solid #475569' }}>AVG CPU</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', borderBottom: '1px solid #475569' }}>AVG LATENCY</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', borderBottom: '1px solid #475569' }}>UPTIME SLA</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>
                    <div style={{ fontSize: '32px', marginBottom: '16px', opacity: 0.5 }}>📊</div>
                    Tekan <strong>Generate Report</strong> untuk menyedot jutaan rekaman mentah dari TimescaleDB dan mengkalkulasikannya menjadi matriks laporan eksekutif.
                  </td>
                </tr>
              ) : (
                reports.sort((a,b) => a.sla_percent - b.sla_percent).map((r, idx) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.2s', cursor: 'default' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                    <td style={{ padding: '14px 16px', color: '#64748b' }}>{idx + 1}</td>
                    <td style={{ padding: '14px 16px', fontWeight: 'bold' }}>{r.name}</td>
                    <td style={{ padding: '14px 16px', fontFamily: 'monospace', color: '#38bdf8' }}>{r.ip}</td>
                    <td style={{ padding: '14px 16px' }}>{r.type}</td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 'bold', color: r.avg_cpu > 70 ? '#ef4444' : '#10b981' }}>{r.avg_cpu}%</td>
                    <td style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 'bold', color: r.avg_ping > 50 ? '#ef4444' : '#10b981' }}>{r.avg_ping} ms</td>
                    <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                      <div style={{ display: 'inline-block', padding: '6px 12px', borderRadius: '12px', background: r.sla_percent >= 99 ? 'rgba(16, 185, 129, 0.15)' : (r.sla_percent > 95 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)'), color: r.sla_percent >= 99 ? '#34d399' : (r.sla_percent > 95 ? '#fbbf24' : '#f87171'), fontWeight: 'bold', letterSpacing: '0.5px' }}>
                        {r.sla_percent}%
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ReportsEngine;
