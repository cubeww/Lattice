import type { LatticeApi } from '../../shared/types';
declare global {
  interface Window {
    lattice: LatticeApi;
  }
}
export {};
