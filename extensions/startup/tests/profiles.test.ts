import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, writeProfile } from "../src/profiles";
test("generated profile preserves foreign content, symlinks and exact replay", () => {
 const root=mkdtempSync(join(tmpdir(),"startup-profile-"));
 try {
  for(const name of ["startup-role-dev","startup-role-pa","startup-loop"]){mkdirSync(join(root,"skills",name),{recursive:true});writeFileSync(join(root,"skills",name,"SKILL.md"),`Complete canonical ${name}`);}
  const profile=loadProfile({skillsRoot:root,role:"dev",employeeId:"owned",generation:1});
  const path=writeProfile({root,profile});const before=readFileSync(path);
  expect(writeProfile({root,profile})).toBe(path);expect(readFileSync(path)).toEqual(before);
  writeFileSync(path,"User-owned agent");expect(()=>writeProfile({root,profile})).toThrow("conflict");expect(readFileSync(path,"utf8")).toBe("User-owned agent");
  rmSync(path);const target=join(root,"user.md");writeFileSync(target,"User agent");symlinkSync(target,path);
  expect(()=>writeProfile({root,profile})).toThrow("conflict");expect(readFileSync(target,"utf8")).toBe("User agent");
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("canonical generated employees admit bounded native procedure helpers", () => {
 const root=mkdtempSync(join(tmpdir(),"startup-helper-profile-"));
 try {
  for(const name of ["startup-role-dev","startup-role-pa","startup-loop"]){mkdirSync(join(root,"skills",name),{recursive:true});writeFileSync(join(root,"skills",name,"SKILL.md"),`Complete canonical ${name}`);}
  const profile=loadProfile({skillsRoot:root,role:"dev",employeeId:"developer",generation:1});
  expect(readFileSync(writeProfile({root,profile}),"utf8")).toContain("spawns: [task]");
  const pa=loadProfile({skillsRoot:root,role:"pa",employeeId:"assistant",generation:1});
  expect(readFileSync(writeProfile({root,profile:pa}),"utf8")).not.toContain("spawns:");
 }finally{rmSync(root,{recursive:true,force:true});}
});
