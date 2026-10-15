import { HostInfoSchema, cpuModelLabel } from '@vps/protocol';
import { describe, expect, it } from 'vitest';

describe('cpuModelLabel', () => {
  it('убирает частоту, (R), (TM) и число ядер физического хоста', () => {
    expect(cpuModelLabel('Intel(R) Xeon(R) CPU E5-2680 v2 @ 2.80GHz')).toBe(
      'Intel Xeon E5-2680 v2',
    );
    expect(cpuModelLabel('AMD EPYC 7542 32-Core Processor')).toBe('AMD EPYC 7542');
    expect(cpuModelLabel('AMD Ryzen 9 5950X 16-Core Processor')).toBe('AMD Ryzen 9 5950X');
    expect(cpuModelLabel('AMD EPYC-Rome Processor')).toBe('AMD EPYC-Rome');
    expect(cpuModelLabel('Intel Xeon Processor (Cascadelake)')).toBe('Intel Xeon (Cascadelake)');
    expect(cpuModelLabel('Intel(R) Xeon(R) Processor @ 2.80GHz')).toBe('Intel Xeon');
  });

  it('спрятанный хостингом процессор - пустая строка', () => {
    expect(cpuModelLabel('QEMU Virtual CPU version 2.5+')).toBe('');
    expect(cpuModelLabel('Common KVM processor')).toBe('');
    expect(cpuModelLabel('')).toBe('');
    expect(cpuModelLabel(undefined)).toBe('');
  });

  it('старый агент без полей и мусор в полях не роняют сведения о хосте', () => {
    const base = {
      hostname: 'h',
      os: 'ubuntu 24.04',
      kernel: '6.8',
      arch: 'amd64',
      agentVersion: '1',
    };
    expect(HostInfoSchema.parse(base).cpuCores).toBeUndefined();
    const bad = HostInfoSchema.parse({ ...base, cpuCores: -1, cpuModel: 5 });
    expect(bad.cpuCores).toBeUndefined();
    expect(bad.cpuModel).toBeUndefined();
    expect(HostInfoSchema.parse({ ...base, cpuCores: 2, cpuModel: 'X' }).cpuCores).toBe(2);
  });
});
