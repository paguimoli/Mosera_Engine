import { listAuthorityApprovalRecords } from "../authority-approval/authority-approval.repository";
import type { AuthorityDomain } from "../authority-control/authority-control.types";

export async function listPromotionApprovalRecords(domain: AuthorityDomain) {
  return listAuthorityApprovalRecords({ authorityCandidate: domain });
}
