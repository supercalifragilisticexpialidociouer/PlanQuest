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
;   [Icons] 只在桌面建一个快捷方式，指向解压后的 PlanQuest.exe（用户明确要求）
;
; 压缩：本脚本 [Files] 为空（引导器无内嵌文件），产物就是 Inno 的几 MB 壳。
; 源地址不写进界面，集中写在「使用说明.txt」；这里只放内置兜底地址。
; 编译：ISCC.exe tools\PlanQuest-Assistant.iss
; 产物：dist\releases\PlanQuest-安装助手.exe
; ============================================================================

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
; 只有桌面快捷方式（见 [Icons]）；无 [Registry] / [Run] —— 不写注册表、不写自启

; 桌面快捷方式：ssPostInstall 之前就会创建，目标 exe 此时还没下载下来，
; 但 Windows 允许 .lnk 指向暂不存在的文件；下载失败时 CurStepChanged 会删掉它。
[Icons]
Name: "{autodesktop}\PlanQuest"; Filename: "{app}\PlanQuest.exe"; Comment: "PlanQuest 绿色版"; IconFilename: "{app}\PlanQuest.exe"

; 说明：本机 Inno Setup 未附中文语言包，沿用默认向导文案（按钮为英文，
; 但自定义页与完成页文案均为中文，见 [Code]）—— 与原 setup.iss 口径一致。

; ============================================================================
; [Files] 故意留空：这个 exe 是「引导器」，不内嵌主程序。
; 主程序在安装阶段由 [Code] 从下载源拉取并解压。
; ============================================================================

[Code]
const
  { 内置兜底源：官方 GitHub 仓库发布页。使用者可在 exe 同目录放一个
    assistant-sources.txt 覆盖（每行一个源，见使用说明.txt）。源不写进 UI。 }
  DEFAULT_SOURCE = 'https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/latest';
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
  SelectedIndex: Integer;

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

{ 下载一个文件到 Target，成功 True；--fail 保证 HTTP 码正确 }
function DownloadTo(const Url, Target: string): Boolean;
var
  Args: string;
begin
  { speed-time/speed-limit：连接半开或网速低于 1KB/s 持续 30 秒就放弃，避免离线时卡死 }
  Args := '-L --fail --silent --show-error --connect-timeout 15 --speed-time 30 --speed-limit 1024 --max-time 3600 -o "' + Target + '" "' + Url + '"';
  Result := CurlExec(Args) and FileExists(Target);
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
    ExeDir := ExtractFilePath(ExpandConstant('{exe}'));
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
  P: Integer;
begin
  Result := '';
  if (VersionCombo = nil) or (VersionCombo.ItemIndex < 0) then Exit;
  S := VersionCombo.Items[VersionCombo.ItemIndex];
  P := Pos('|', S);
  if P > 0 then Result := Trim(Copy(S, 1, P - 1)) else Result := Trim(S);
end;

{ 按选中版本组装下载源：GitHub tag 直链优先，再拼上自定义源 }
function BuildDownloadUrls(const Ver: string): TStringList;
var
  Custom: TStringList;
  I: Integer;
  U: string;
begin
  Result := TStringList.Create;
  Result.Add('https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/download/v' + Ver + '/PlanQuest-win64-portable.zip');
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

{ 按源顺序下载主包：任一成功即可 }
function FetchMainPackage(const Ver, Target: string): Boolean;
var
  Urls: TStringList;
  I: Integer;
begin
  Result := False;
  Urls := BuildDownloadUrls(Ver);
  try
    for I := 0 to Urls.Count - 1 do
    begin
      WizardForm.StatusLabel.Caption := '正在下载 ' + Ver + ' 绿色包（源 ' + IntToStr(I + 1) + '/' + IntToStr(Urls.Count) + '）…';
      WizardForm.StatusLabel.Update;
      if DownloadTo(Urls[I], Target) then
      begin
        Result := True;
        Exit;
      end;
    end;
  finally
    Urls.Free;
  end;
end;

{ 解压 zip 到 DestDir：优先系统 tar（Win10 自带），--strip-components 1 去顶层目录 }
function UnzipTo(const ZipFile, DestDir: string): Boolean;
var
  Tar, PsExe, Args: string;
  RC: Integer;
begin
  ForceDirectories(DestDir);
  Tar := ExpandConstant('{sys}\tar.exe');
  if FileExists(Tar) then
  begin
    Args := '-xf "' + ZipFile + '" -C "' + DestDir + '" --strip-components 1';
    Result := Exec(Tar, Args, '', SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
    if Result then Exit;
  end;
  PsExe := ExpandConstant('{sys}\windowspowershell\v1.0\powershell.exe');
  Args := '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''{0}'' -DestinationPath ''{1}'' -Force"';
  Args := Format(Args, [ZipFile, DestDir]);
  Result := Exec(PsExe, Args, '', SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
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
  CapLabel, TipLabel: TLabel;
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
  for I := 0 to High(AvailVersions) do
  begin
    Parts := SplitBy(AvailVersions[I], '|');
    try
      if Parts.Count >= 2 then
        VersionCombo.Items.Add(Trim(Parts[0]) + '  ' + Trim(Parts[1]))
      else
        VersionCombo.Items.Add(AvailVersions[I]);
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
  TipLabel.Width := 390; TipLabel.Height := 48;
  TipLabel.AutoSize := False; TipLabel.WordWrap := True;
  TipLabel.Caption := 'AI 不勾 → 一个字节都不下。下载源不写在这里，见安装目录的「使用说明.txt」。';

  OllamaCheck := TCheckBox.Create(SelectPage);
  OllamaCheck.Parent := SelectPage.Surface;
  OllamaCheck.Left := 0; OllamaCheck.Top := 92;
  OllamaCheck.Width := 470;
  OllamaCheck.Caption := '同时装 Ollama 绿色版（官网 zip 约 1.5 GB，模型另需 1.9 GB）';
  OllamaCheck.Checked := False;

  MeloTsCheck := TCheckBox.Create(SelectPage);
  MeloTsCheck.Parent := SelectPage.Surface;
  MeloTsCheck.Left := 0; MeloTsCheck.Top := 118;
  MeloTsCheck.Width := 470;
  MeloTsCheck.Caption := '同时装 MeloTTS 源码（官网无 Windows 运行包，仅源码 zip）';
  MeloTsCheck.Checked := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Ver, Tmp, ZipFile, CompDir: string;
begin
  if CurStep <> ssPostInstall then Exit;

  Ver := CurrentVersion;
  if Ver = '' then Ver := '2.9.11';
  Tmp := ExpandConstant('{tmp}');
  ZipFile := AddBackslash(Tmp) + 'pq-' + Ver + '.zip';

  if not FetchMainPackage(Ver, ZipFile) then
  begin
    { 主包没下到 → 删掉 [Icons] 预先建的桌面快捷方式，不留指向空文件的死链 }
    DeleteFile(ExpandConstant('{autodesktop}\PlanQuest.lnk'));
    MsgBox('下载 ' + Ver + ' 失败：所有源都没拿到包。' + #13#10 +
           '请检查网络，或按「使用说明.txt」配置自己的下载源后重试。', mbError, MB_OK);
    Exit;
  end;

  WizardForm.StatusLabel.Caption := '正在解压 ' + Ver + ' 到 ' + ExpandConstant('{app}') + ' …';
  WizardForm.StatusLabel.Update;
  UnzipTo(ZipFile, ExpandConstant('{app}'));

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
    WizardForm.FinishedLabel.Caption :=
      '安装完成：' + CurrentVersion + ' 绿色版已解压到所选目录，桌面已创建「PlanQuest」快捷方式。' + #13#10 + #13#10 +
      '未请求管理员权限、未写注册表、未建开始菜单或卸载项。' + #13#10 +
      '开机自启请在应用「设置」里开启（会写 HKCU\...\Run，仅自己生效）。' + #13#10 + #13#10 +
      '计划数据在 %APPDATA%\PlanQuest\，换版本自动沿用，无需迁移。';
end;
