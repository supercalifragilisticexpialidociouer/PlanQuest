; ============================================================================
; PlanQuest 安装助手（纯引导器 / bootstrapper）
; ----------------------------------------------------------------------------
; 和 PlanQuest-setup.iss 的区别：
;   - setup.iss   内嵌整包（约 160 MB），双击离线就能装上，但只能装固定版本；
;   - 本脚本       只打一个几 MB 的小 exe，本身不含主程序。运行时让你
;                  ① 选装哪个版本  ② 勾要不要装 AI，再去下载源把对应版本
;                  的绿色 ZIP 拉下来、校验、解压到目标目录。
;
; 约束（勿删）：
;   PrivilegesRequired=lowest        普通用户权限，不弹 UAC
;   CreateUninstallRegKey=no         不写卸载注册表
;   Uninstallable=no                 不生成卸载程序
;   DisableProgramGroupPage=yes      不建开始菜单
;   无 [Registry] / [Run]            安装器不写注册表、不写自启
;   [Icons] 不静态创建：解压完成后由 [Code] 动态建桌面快捷方式，
;           目标指向真实解压出来的 PlanQuest.exe，图标用软件自带的 PlanQuest.ico。
;   ZIP 原封不动完整解压：不用 --strip-components，保留包内 PlanQuest-win64\ 目录。
;
; 压缩：本脚本 [Files] 为空（引导器无内嵌文件），产物就是 Inno 的几 MB 壳。
; 源地址不写进界面，集中写在「使用说明.txt」；这里只放内置兜底地址。
; 编译：ISCC.exe tools\PlanQuest-Assistant.iss
; 产物：dist\releases\PlanQuest-安装助手.exe
; ============================================================================

[Languages]
; 官方简体中文语言包（Inno Setup 6.5+），路径相对本脚本，随源码一起分发。
Name: "zh"; MessagesFile: "lang\ChineseSimplified.isl"

[Setup]
AppName=PlanQuest 安装助手
AppVersion=1.0
AppVerName=PlanQuest 安装助手（选版本 + 选 AI）
AppPublisher=PlanQuest
DefaultDirName={localappdata}\PlanQuest\app
DefaultGroupName=
DisableProgramGroupPage=yes
DisableReadyPage=no
AllowNoIcons=yes
PrivilegesRequired=lowest
CreateUninstallRegKey=no
Uninstallable=no
UpdateUninstallLogAppName=no
CloseApplications=no
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputDir=..\dist\releases
OutputBaseFilename=PlanQuest-安装助手
SetupIconFile=..\dist\PlanQuest-win64\PlanQuest.ico
; 只有桌面快捷方式（见 [Code] 里的 CreateDesktopShortcut）；无 [Registry] / [Run]
; —— 不写注册表、不写自启。

; ============================================================================
; [Files] 故意留空：这个 exe 是「引导器」，不内嵌主程序。
; 主程序在安装阶段由 [Code] 从下载源拉取并原样完整解压。
; ============================================================================

[Code]
const
  { 内置兜底源：官方 GitHub 仓库发布页。使用者可在 exe 同目录放一个
    assistant-sources.txt 覆盖（每行一个源，见使用说明.txt）。源不写进 UI。 }
  DEFAULT_SOURCE = 'https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/latest';
  { GitHub API 资产接口：代理/网络拦 releases/download 时仍可下载，首选 }
  API_RELEASES = 'https://api.github.com/repos/supercalifragilisticexpialidociouer/PlanQuest/releases';
  { 可选组件：只下不解压，放到安装目录下的 components\ }
  OLLAMA_URL = 'https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-windows-amd64.zip';
  MELOTTS_URL = 'https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip';
  MELOTTS_GHPROXY = 'https://ghproxy.net/https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip';

var
  VersionCombo: TComboBox;
  OllamaCheck: TCheckBox;
  MeloTsCheck: TCheckBox;
  SelectPage: TWizardPage;
  AvailVersions: array of string;   { 形如 "版本|说明" }
  VersionKeys: array of string;     { 下拉框每一项对应的纯版本号 }
  SelectedIndex: Integer;
  InstalledExe: string;             { 解压后真实主程序路径，供完成页显示 }

{ ---------- 全部辅助函数按依赖顺序定义（Inno Pascal 不支持先使用后定义） ---------- }

function IsHttpUrl(const S: string): Boolean;
begin
  Result := (Lowercase(Copy(S, 1, 7)) = 'http://') or (Lowercase(Copy(S, 1, 8)) = 'https://');
end;

{ 自己实现 split：按分隔符把 S 拆成 TStringList }
function SplitBy(const S, Delim: string): TStringList;
var
  L: TStringList;
  Rest, Tok: string;
  P: Integer;
begin
  L := TStringList.Create;
  Rest := S;
  while True do
  begin
    P := Pos(Delim, Rest);
    if P <= 0 then Break;
    Tok := Copy(Rest, 1, P - 1);
    L.Add(Tok);
    Rest := Copy(Rest, P + Length(Delim), Length(Rest) - P - Length(Delim) + 1);
  end;
  L.Add(Rest);
  Result := L;
end;

{ 调系统 curl.exe 执行一段参数，返回退出码是否为 0 }
function CurlExec(const Args: string): Boolean;
var
  RC: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\curl.exe'), Args, ExpandConstant('{tmp}'),
                 SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
end;

{ 下载一个文件到 Target，成功 True；--fail 保证 HTTP 码正确。
  Extra 用来给 GitHub API 资产加 Accept 头，普通直链传空串。 }
function DownloadToEx(const Url, Target, Extra: string): Boolean;
var
  Args, ErrFile: string;
begin
  { speed-time/speed-limit：连接半开或网速低于 1KB/s 持续 30 秒就放弃，避免离线时卡死 }
  ErrFile := AddBackslash(ExpandConstant('{localappdata}')) + 'Temp\pq-curl-last.log';
  Args := '-L --fail --silent --show-error --connect-timeout 15 --speed-time 30 --speed-limit 1024 --max-time 3600 ' + Extra +
          '--stderr "' + ErrFile + '" -o "' + Target + '" "' + Url + '"';
  Result := CurlExec(Args) and FileExists(Target);
end;

function DownloadTo(const Url, Target: string): Boolean;
begin
  Result := DownloadToEx(Url, Target, '');
end;

{ 从 release JSON 里找指定资产名对应的 API 下载直链 }
function ExtractAssetApiUrl(const S, AssetName: string): string;
var
  NamePat, UrlPat, Rest, U, LastUrl: string;
  NamePos, StartPos, P, AbsP, Q, E: Integer;
begin
  Result := '';
  NamePat := '"name": "' + AssetName + '"';
  NamePos := Pos(NamePat, S);
  if NamePos <= 0 then Exit;
  UrlPat := '"url": "https://api.github.com/';
  LastUrl := '';
  StartPos := 1;
  while StartPos < NamePos do
  begin
    Rest := Copy(S, StartPos, NamePos - StartPos);
    P := Pos(UrlPat, Rest);
    if P <= 0 then Break;
    AbsP := StartPos + P - 1;
    Q := AbsP + Length(UrlPat);
    E := Q;
    while (E <= Length(S)) and (S[E] <> '"') do Inc(E);
    U := 'https://api.github.com/' + Copy(S, Q, E - Q);
    if Pos('/releases/assets/', U) > 0 then LastUrl := U;
    StartPos := E + 1;
  end;
  Result := LastUrl;
end;

{ 取指定版本（或最新版）的指定资产 API 直链；失败返回空串 }
function FetchApiAssetUrl(const Ver, AssetName: string): string;
var
  JsonFile, S: string;
  L: TStringList;
begin
  Result := '';
  JsonFile := AddBackslash(ExpandConstant('{tmp}')) + 'pq-release-' + Ver + '.json';
  if not DownloadToEx(API_RELEASES + '/tags/v' + Ver, JsonFile, '-H "Accept: application/vnd.github+json" ') then
    DeleteFile(JsonFile);
  if not FileExists(JsonFile) then
    if not DownloadToEx(API_RELEASES + '/latest', JsonFile, '-H "Accept: application/vnd.github+json" ') then Exit;
  L := TStringList.Create;
  try
    L.LoadFromFile(JsonFile);
    S := L.Text;
  finally
    L.Free;
  end;
  Result := ExtractAssetApiUrl(S, AssetName);
end;

{ 读源：优先 exe 同目录的 assistant-sources.txt（每行一个），否则内置兜底 }
function LoadSources: TStringList;
var
  Lines, SrcList: TStringList;
  ExeDir, Custom: string;
  I: Integer;
  S: string;
begin
  SrcList := TStringList.Create;
  Lines := TStringList.Create;
  try
    ExeDir := ExtractFilePath(ExpandConstant('{srcexe}'));
    Custom := AddBackslash(ExeDir) + 'assistant-sources.txt';
    if FileExists(Custom) then Lines.LoadFromFile(Custom);
    if Lines.Count > 0 then
    begin
      for I := 0 to Lines.Count - 1 do
      begin
        S := Trim(Lines[I]);
        if (S <> '') and (Copy(S, 1, 1) <> '#') and IsHttpUrl(S) then SrcList.Add(S);
      end;
    end;
    if SrcList.Count = 0 then SrcList.Add(DEFAULT_SOURCE);
  finally
    Lines.Free;
  end;
  Result := SrcList;
end;

{ 在一段 JSON 文本里取 "key": "value" 的 value }
function ExtractJsonString(const S, Key: string): string;
var
  KP, Colon, Q1, Q2: Integer;
begin
  Result := '';
  KP := Pos('"' + Key + '"', S);
  if KP <= 0 then Exit;
  Colon := Pos(':', Copy(S, KP, Length(S) - KP + 1));
  if Colon <= 0 then Exit;
  Q1 := KP + Colon - 1;
  while (Q1 <= Length(S)) and (S[Q1] <> '"') do Inc(Q1);
  if Q1 > Length(S) then Exit;
  Q2 := Q1 + 1;
  while (Q2 <= Length(S)) and (S[Q2] <> '"') do Inc(Q2);
  if Q2 > Length(S) then Exit;
  Result := Copy(S, Q1 + 1, Q2 - Q1 - 1);
end;

{ 联网拉最新版本（GitHub Releases API）；成功则把列表第一项换成线上版本 }
function FetchVersions: Boolean;
var
  JsonFile, S, Ver, Notes: string;
  L: TStringList;
  Srcs: TStringList;
begin
  Result := False;
  JsonFile := AddBackslash(ExpandConstant('{tmp}')) + 'pq-releases.json';
  Srcs := LoadSources;
  try
    S := Srcs[0];
    if Pos('api.github.com', S) = 0 then
      S := 'https://api.github.com/repos/supercalifragilisticexpialidociouer/PlanQuest/releases/latest';
    if not DownloadTo(S, JsonFile) then Exit;
    L := TStringList.Create;
    try
      L.LoadFromFile(JsonFile);
      S := L.Text;
    finally
      L.Free;
    end;
    Ver := ExtractJsonString(S, 'tag_name');
    if (Length(Ver) > 0) and (Ver[1] = 'v') then Ver := Copy(Ver, 2, Length(Ver) - 1);
    if Ver = '' then Exit;
    Notes := ExtractJsonString(S, 'name');
    if Length(AvailVersions) > 0 then
      AvailVersions[0] := Ver + '|' + Notes
    else
    begin
      SetLength(AvailVersions, 1);
      AvailVersions[0] := Ver + '|' + Notes;
    end;
    if Length(VersionKeys) = 0 then SetLength(VersionKeys, Length(AvailVersions));
    VersionKeys[0] := Ver;
    Result := True;
  finally
    Srcs.Free;
  end;
end;

procedure AddBuiltinVersions;
begin
  { 格式为 版本|说明；下载直链由版本按 releases/download/v＋版本号 规则拼出，
    用户可在 assistant-sources.txt 里为某个版本指定专属直链（见使用说明.txt）。 }
  SetLength(AvailVersions, 3);
  AvailVersions[0] := '2.9.11|新手期翻案隔离 · 五源冗余更新（推荐）';
  AvailVersions[1] := '2.9.10|修复阿刺伪造用户发言';
  AvailVersions[2] := '2.9.9|绿色安装器 · 可选大模型';
end;

procedure VersionComboChange(Sender: TObject);
begin
  SelectedIndex := VersionCombo.ItemIndex;
end;

function CurrentVersion: string;
var
  S: string;
  P, Idx: Integer;
begin
  Result := '';
  if (VersionCombo = nil) or (VersionCombo.ItemIndex < 0) then Exit;
  Idx := VersionCombo.ItemIndex;
  { 下拉框显示的是「版本  说明」，不能用它拼 URL；只取 VersionKeys 里的纯版本号 }
  if (Idx >= 0) and (Idx < Length(VersionKeys)) and (VersionKeys[Idx] <> '') then
  begin
    Result := VersionKeys[Idx];
    Exit;
  end;
  S := VersionCombo.Items[Idx];
  P := Pos('|', S);
  if P > 0 then Result := Trim(Copy(S, 1, P - 1)) else Result := Trim(Copy(S, 1, Pos('  ', S + '  ') - 1));
end;

{ 按选中版本组装下载源：GitHub API 资产接口优先（代理常拦 releases 直链），
  再退回 releases 直链，最后拼上自定义源 }
function BuildDownloadUrls(const Ver: string): TStringList;
var
  Custom: TStringList;
  I: Integer;
  U, ApiUrl, BackupUrl: string;
begin
  Result := TStringList.Create;
  ApiUrl := FetchApiAssetUrl(Ver, 'PlanQuest-win64-portable.zip');
  if ApiUrl <> '' then Result.Add(ApiUrl);
  BackupUrl := FetchApiAssetUrl(Ver, 'PlanQuest-win64-portable-backup.zip');
  if (BackupUrl <> '') and (Result.IndexOf(BackupUrl) < 0) then Result.Add(BackupUrl);
  Result.Add('https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/download/v' + Ver + '/PlanQuest-win64-portable.zip');
  Result.Add('https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/download/v' + Ver + '/PlanQuest-win64-portable-backup.zip');
  Result.Add('https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/download/' + Ver + '/PlanQuest-win64-portable.zip');
  Custom := LoadSources;
  try
    for I := 0 to Custom.Count - 1 do
    begin
      U := Custom[I];
      if (Pos('api.github.com', U) > 0) or (Pos('releases/latest', U) > 0) then Continue;
      if Result.IndexOf(U) < 0 then Result.Add(U);
    end;
  finally
    Custom.Free;
  end;
end;

function ReadFileText(const Path: string): string;
var
  L: TStringList;
begin
  Result := '';
  L := TStringList.Create;
  try
    try L.LoadFromFile(Path); Result := Trim(L.Text); except end;
  finally
    L.Free;
  end;
end;

{ 按源顺序下载主包：任一成功即可；每个失败源都写进安装目录 pq-download.log }
function FetchMainPackage(const Ver, Target: string): Boolean;
var
  Urls, Failed: TStringList;
  I: Integer;
  OK: Boolean;
  LogFile, ErrFile: string;
begin
  Result := False;
  Urls := BuildDownloadUrls(Ver);
  Failed := TStringList.Create;
  try
    for I := 0 to Urls.Count - 1 do
    begin
      WizardForm.StatusLabel.Caption := '正在下载 ' + Ver + ' 绿色包（源 ' + IntToStr(I + 1) + '/' + IntToStr(Urls.Count) + '）…';
      WizardForm.StatusLabel.Update;
      DeleteFile(Target);
      if Pos('/releases/assets/', Urls[I]) > 0 then
        OK := DownloadToEx(Urls[I], Target, '-H "Accept: application/octet-stream" ')
      else
        OK := DownloadTo(Urls[I], Target);
      if OK then
      begin
        Result := True;
        Exit;
      end;
      Failed.Add('失败源 ' + IntToStr(I + 1) + ': ' + Urls[I]);
      ErrFile := AddBackslash(ExpandConstant('{localappdata}')) + 'Temp\pq-curl-last.log';
      if FileExists(ErrFile) then
        Failed.Add('  curl: ' + Trim(ReadFileText(ErrFile)));
    end;
    Failed.Add('版本: ' + Ver + '，目标: ' + Target);
    Failed.Add('提示: 若 GitHub Releases 被拦，可把 API 资产直链写进 assistant-sources.txt。');
    LogFile := AddBackslash(ExpandConstant('{app}')) + 'pq-download.log';
    try Failed.SaveToFile(LogFile); except end;
  finally
    Urls.Free;
    Failed.Free;
  end;
end;

{ 在解压目录里找到真正的主程序；兼容 zip 顶层目录名变化 }
function FindExtractedExe(const Root: string): string;
var
  P, Sub: string;
  I: Integer;
begin
  Result := '';
  { 官方绿色包解压后主程序在 PlanQuest-win64\ 下；兼容早期直接放根目录的包 }
  P := AddBackslash(Root) + 'PlanQuest-win64\PlanQuest.exe';
  if FileExists(P) then begin Result := P; Exit; end;
  P := AddBackslash(Root) + 'PlanQuest.exe';
  if FileExists(P) then begin Result := P; Exit; end;
  { 兼容常见顶层目录名变化（不用 FindFirst，避免 Inno 编译器类型差异） }
  for I := 1 to 3 do
  begin
    case I of
      1: Sub := 'PlanQuest-win64-portable';
      2: Sub := 'PlanQuest';
      3: Sub := 'PlanQuest-win64-release';
    end;
    P := AddBackslash(Root) + Sub + '\PlanQuest.exe';
    if FileExists(P) then begin Result := P; Exit; end;
  end;
end;

{ 下载物存在性检查；内容是否为有效 ZIP 由 tar / PowerShell 解压结果判定 }
function IsZipFile(const Path: string): Boolean;
begin
  Result := FileExists(Path);
end;

procedure SaveExtractLog(const Log: TStringList);
var
  Path: string;
begin
  Path := AddBackslash(ExpandConstant('{app}')) + 'pq-extract.log';
  try Log.SaveToFile(Path); except end;
end;

{ ZIP 原封不动完整解压：保留包内目录结构，不 strip。
  tar 优先，失败退回 PowerShell Expand-Archive；每步 RC 与找到的 exe 都写日志。 }
function UnzipTo(const ZipFile, DestDir: string): Boolean;
var
  Tar, PsExe, Args, Found, IsZip: string;
  RC: Integer;
  Log: TStringList;
begin
  Result := False;
  Log := TStringList.Create;
  try
    ForceDirectories(DestDir);
    if IsZipFile(ZipFile) then IsZip := 'true' else IsZip := 'false';
    Log.Add('目标目录: ' + DestDir);
    Log.Add('ZIP: ' + ZipFile + '  是ZIP=' + IsZip);
    if IsZip <> 'true' then
    begin
      Log.Add('错误: 下载物不是 ZIP，可能拿到了错误页');
      SaveExtractLog(Log);
      Exit;
    end;

    Tar := ExpandConstant('{sys}\tar.exe');
    if FileExists(Tar) then
    begin
      Args := '-xf "' + ZipFile + '" -C "' + DestDir + '"';
      RC := -1;
      Exec(Tar, Args, '', SW_HIDE, ewWaitUntilTerminated, RC);
      Found := FindExtractedExe(DestDir);
      Log.Add('tar.exe RC=' + IntToStr(RC) + '  找到exe=' + Found);
      if (RC = 0) and (Found <> '') then
      begin
        Result := True;
        SaveExtractLog(Log);
        Exit;
      end;
    end
    else
      Log.Add('tar.exe 不存在，跳过');

    PsExe := ExpandConstant('{sys}\windowspowershell\v1.0\powershell.exe');
    Args := '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''{0}'' -DestinationPath ''{1}'' -Force"';
    Args := Format(Args, [ZipFile, DestDir]);
    RC := -1;
    Exec(PsExe, Args, '', SW_HIDE, ewWaitUntilTerminated, RC);
    Found := FindExtractedExe(DestDir);
    Log.Add('PowerShell RC=' + IntToStr(RC) + '  找到exe=' + Found);
    Result := (RC = 0) and (Found <> '');
  finally
    SaveExtractLog(Log);
    Log.Free;
  end;
end;

{ 解压成功后才建桌面快捷方式：目标 = 真实 exe，图标 = 软件自带的 PlanQuest.ico }
procedure CreateDesktopShortcut(const ExePath: string);
var
  ShellObj, Link: Variant;
  IconPath, LinkPath: string;
begin
  IconPath := ExtractFilePath(ExePath) + 'PlanQuest.ico';
  if not FileExists(IconPath) then IconPath := ExePath;
  LinkPath := AddBackslash(ExpandConstant('{autodesktop}')) + 'PlanQuest.lnk';
  try
    ShellObj := CreateOleObject('WScript.Shell');
    Link := ShellObj.CreateShortcut(LinkPath);
    Link.TargetPath := ExePath;
    Link.WorkingDirectory := ExtractFilePath(ExePath);
    Link.Arguments := '';
    Link.Description := 'PlanQuest 绿色版';
    Link.IconLocation := IconPath + ',0';
    Link.Save;
  except
    MsgBox('桌面快捷方式创建失败，可手动运行：' + ExePath, mbError, MB_OK);
  end;
end;

procedure DownloadComponent(const Url, Dest, LabelText: string);
begin
  WizardForm.StatusLabel.Caption := '正在下载 ' + LabelText + ' …（不勾不会下）';
  WizardForm.StatusLabel.Update;
  if FileExists(Dest) then Exit;
  ForceDirectories(ExtractFilePath(Dest));
  DownloadTo(Url, Dest);
end;

{ 自定义向导页：选版本 + 选 AI }
procedure CreateSelectPage;
var
  I: Integer;
  Parts: TStringList;
  CapLabel, TipLabel, SpaceLabel: TLabel;
begin
  SelectPage := CreateCustomPage(wpSelectDir, '选择版本与组件',
    '选要装的 PlanQuest 版本；AI 组件默认不装，勾了才从官网下载。');

  CapLabel := TLabel.Create(SelectPage);
  CapLabel.Parent := SelectPage.Surface;
  CapLabel.Caption := '安装版本：';
  CapLabel.Left := 0; CapLabel.Top := 10;

  VersionCombo := TComboBox.Create(SelectPage);
  VersionCombo.Parent := SelectPage.Surface;
  VersionCombo.Left := 80; VersionCombo.Top := 5;
  VersionCombo.Width := 380;
  SetLength(VersionKeys, Length(AvailVersions));
  for I := 0 to High(AvailVersions) do
  begin
    Parts := SplitBy(AvailVersions[I], '|');
    try
      VersionKeys[I] := Trim(Parts[0]);
      if Parts.Count >= 2 then
        VersionCombo.Items.Add(VersionKeys[I] + '  ' + Trim(Parts[1]))
      else
        VersionCombo.Items.Add(VersionKeys[I]);
    finally
      Parts.Free;
    end;
  end;
  if VersionCombo.Items.Count > 0 then VersionCombo.ItemIndex := 0;
  SelectedIndex := 0;
  VersionCombo.OnChange := @VersionComboChange;

  TipLabel := TLabel.Create(SelectPage);
  TipLabel.Parent := SelectPage.Surface;
  TipLabel.Left := 80; TipLabel.Top := 34;
  TipLabel.Width := 390; TipLabel.Height := 20;
  TipLabel.AutoSize := False; TipLabel.WordWrap := True;
  TipLabel.Caption := 'AI 不勾 → 一个字节都不下。下载源见「使用说明.txt」。';

  SpaceLabel := TLabel.Create(SelectPage);
  SpaceLabel.Parent := SelectPage.Surface;
  SpaceLabel.Left := 80; SpaceLabel.Top := 56;
  SpaceLabel.Width := 390; SpaceLabel.Height := 38;
  SpaceLabel.AutoSize := False; SpaceLabel.WordWrap := True;
  SpaceLabel.Caption := '所需磁盘空间：主程序解压后约 376 MiB；下载临时文件再占 194 MiB，' +
                        '峰值约 570 MiB（不含可选 AI 组件）。';

  OllamaCheck := TCheckBox.Create(SelectPage);
  OllamaCheck.Parent := SelectPage.Surface;
  OllamaCheck.Left := 0; OllamaCheck.Top := 102;
  OllamaCheck.Width := 470;
  OllamaCheck.Caption := '同时装 Ollama 绿色版（官网 zip 约 1.5 GB，模型另需 1.9 GB）';
  OllamaCheck.Checked := False;

  MeloTsCheck := TCheckBox.Create(SelectPage);
  MeloTsCheck.Parent := SelectPage.Surface;
  MeloTsCheck.Left := 0; MeloTsCheck.Top := 128;
  MeloTsCheck.Width := 470;
  MeloTsCheck.Caption := '同时装 MeloTTS 源码（官网无 Windows 运行包，仅源码 zip）';
  MeloTsCheck.Checked := False;
end;

{ 已有 exe 先改名，避免应用运行时覆盖失败；改名失败说明被占用 }
function PrepareTarget(const DestDir: string; var OldExe: string): Boolean;
var
  Exe: string;
begin
  Result := True;
  OldExe := '';
  Exe := FindExtractedExe(DestDir);
  if Exe = '' then Exit;
  if FileExists(Exe + '.old') then DeleteFile(Exe + '.old');
  if RenameFile(Exe, Exe + '.old') then
    OldExe := Exe
  else
  begin
    Result := False;
    MsgBox('目标目录里的 PlanQuest.exe 无法替换（通常是因为应用正在运行）。' + #13#10 +
           '请先完全退出 PlanQuest（托盘图标也要退出），再重新运行安装助手。', mbError, MB_OK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Ver, Tmp, ZipFile, CompDir, ExePath, OldExe: string;
begin
  if CurStep <> ssPostInstall then Exit;

  InstalledExe := '';
  { 不预先删快捷方式：失败时保留原来可用的快捷方式 }
  Ver := CurrentVersion;
  if Ver = '' then Ver := '2.9.11';
  Tmp := ExpandConstant('{tmp}');
  ZipFile := AddBackslash(Tmp) + 'pq-' + Ver + '.zip';

  if not FetchMainPackage(Ver, ZipFile) then
  begin
    MsgBox('下载 ' + Ver + ' 失败：所有源都没拿到包。' + #13#10 +
           '失败详情见所选安装目录的 pq-download.log。' + #13#10 +
           '请检查网络，或按「使用说明.txt」配置自己的下载源后重试。' + #13#10 +
           '所需空间：安装后约 376 MiB，下载临时文件约 194 MiB，峰值约 570 MiB。', mbError, MB_OK);
    Exit;
  end;

  if not PrepareTarget(ExpandConstant('{app}'), OldExe) then Exit;

  WizardForm.StatusLabel.Caption := '正在原样完整解压 ' + Ver + ' 到 ' + ExpandConstant('{app}') + ' …';
  WizardForm.StatusLabel.Update;
  if not UnzipTo(ZipFile, ExpandConstant('{app}')) then
  begin
    if OldExe <> '' then RenameFile(OldExe + '.old', OldExe);
    DeleteFile(ExpandConstant('{autodesktop}\PlanQuest.lnk'));
    MsgBox('解压 ' + Ver + ' 失败：目标目录里没有找到 PlanQuest.exe。' + #13#10 +
           '详情见所选安装目录的 pq-extract.log。' + #13#10 +
           '若应用正在运行，请先完全退出再重试；也可换一个空目录安装。', mbError, MB_OK);
    Exit;
  end;
  if OldExe <> '' then DeleteFile(OldExe + '.old');

  ExePath := FindExtractedExe(ExpandConstant('{app}'));
  InstalledExe := ExePath;
  CreateDesktopShortcut(ExePath);

  CompDir := AddBackslash(ExpandConstant('{app}')) + 'components';
  if (OllamaCheck <> nil) and OllamaCheck.Checked then
    DownloadComponent(OLLAMA_URL, AddBackslash(CompDir) + 'ollama\ollama-windows-amd64.zip', 'Ollama');
  if (MeloTsCheck <> nil) and MeloTsCheck.Checked then
  begin
    DownloadComponent(MELOTTS_URL, AddBackslash(CompDir) + 'melotts\MeloTTS-main.zip', 'MeloTTS');
    if not FileExists(AddBackslash(CompDir) + 'melotts\MeloTTS-main.zip') then
      DownloadComponent(MELOTTS_GHPROXY, AddBackslash(CompDir) + 'melotts\MeloTTS-main.zip', 'MeloTTS（备用源）');
  end;
end;

procedure InitializeWizard;
begin
  { 刻意不在这里联网拉版本列表：离线时 curl 会卡住整个向导几十秒。
    用内置版本列表即可，选完版本在安装阶段才联网，失败有明确报错。 }
  SetLength(AvailVersions, 0);
  AddBuiltinVersions;
  CreateSelectPage;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if InstalledExe = '' then
      WizardForm.FinishedLabel.Caption :=
        '安装未完成：主程序没有解压成功，详见上一步的提示。' + #13#10 + #13#10 +
        '请重新运行安装助手，或在「使用说明.txt」里换一个下载源。'
    else
      WizardForm.FinishedLabel.Caption :=
        '安装完成：' + CurrentVersion + ' 绿色版已原样完整解压到所选目录。' + #13#10 +
        '主程序：' + InstalledExe + #13#10 +
        '桌面「PlanQuest」快捷方式已指向上面的程序，图标使用软件自带图标。' + #13#10 + #13#10 +
        '未请求管理员权限、未写注册表、未建开始菜单或卸载项。' + #13#10 +
        '开机自启请在应用「设置」里开启（会写 HKCU\...\Run，仅自己生效）。' + #13#10 + #13#10 +
        '计划数据在 %APPDATA%\PlanQuest\，换版本自动沿用，无需迁移。';
  end;
end;
