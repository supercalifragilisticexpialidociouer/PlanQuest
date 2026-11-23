; PlanQuest 绿色安装程序 —— 不提权、只解压、不写系统
; 编译：ISCC.exe tools\PlanQuest-setup.iss
; 产物：dist\releases\PlanQuest-<ver>-setup.exe（单文件）
;
; 设计约束（勿删）：
;   PrivilegesRequired=lowest      普通用户权限，不弹 UAC
;   CreateUninstallRegKey=no       不写卸载注册表项
;   Uninstallable=no               不生成卸载程序
;   DisableProgramGroupPage=yes    不建开始菜单
;   [Files] 只有一条递归释放      等价于「把绿色版目录解压出来」
; 额外动作：用户勾了可选大模型，才从官网下载到「安装文件夹内」的 components\；
;   每个组件配主源 + 备用源，任一成功即可（国外源不稳定时的冗余）。
; 主程序包内嵌、不联网 —— 双击必装上；多源冗余更新由应用内「版本更新」面板负责。

[Setup]
AppName=PlanQuest
AppVersion=2.9.11
AppVerName=PlanQuest 2.9.11
AppPublisher=PlanQuest
DefaultDirName={localappdata}\PlanQuest\app
DefaultGroupName=
DisableProgramGroupPage=yes
DisableStartupPrompt=yes
DisableReadyPage=no
AllowNoIcons=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
CreateUninstallRegKey=no
Uninstallable=no
UpdateUninstallLogAppName=no
CloseApplications=no
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputDir=..\dist\releases
OutputBaseFilename=PlanQuest-2.9.11-setup
SetupIconFile=..\dist\PlanQuest-win64\PlanQuest.ico
; 注意：不要加 [Icons] / [Registry] / [Run] —— 本安装器不改系统

[Tasks]
Name: "ollama"; Description: "下载 Ollama 绿色版（官网 zip，约 1.5 GB，模型另需 1.9 GB）"; GroupDescription: "可选大模型（不勾选就一个字节都不下载）"; Flags: unchecked
Name: "melotts"; Description: "下载 MeloTTS 源码（官网无运行包，需自备 Python 3.10）"; GroupDescription: "可选大模型（不勾选就一个字节都不下载）"; Flags: unchecked

[Files]
Source: "..\dist\PlanQuest-win64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
const
  { 每个组件主源 + 备用源（分号分隔），任一成功即可 —— 国外源不稳定时的冗余 }
  OLLAMA_SOURCES = 'https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-windows-amd64.zip';
  MELOTTS_SOURCES = 'https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip;https://ghproxy.net/https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip';

function DownloadOne(Url, Target: String): Boolean;
var
  Cmd: String;
  RC: Integer;
begin
  Cmd := Format('/c curl.exe -L --fail --silent --show-error --connect-timeout 15 --max-time 900 -o "%s" "%s"', [Target, Url]);
  Result := Exec(ExpandConstant('{cmd}'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, RC) and (RC = 0);
  { curl 的 --fail 已保证 HTTP 成功；这里只确认文件确实落盘（不依赖 FileSize 函数） }
  if Result and (not FileExists(Target)) then Result := False;
end;

function DownloadTo(Sources, Rel: String): Boolean;
var
  Target, Base, Rest, Url: String;
  P: Integer;
begin
  { 装到「安装文件夹内」的 components —— 绿色版拷走目录时 AI 一起带走 }
  Base := ExpandConstant('{app}\components');
  Target := Base + '\' + Rel;
  ForceDirectories(ExtractFilePath(Target));
  WizardForm.StatusLabel.Caption := '正在下载 ' + ExtractFileName(Target) + ' …（不勾选则不会走到这一步）';
  WizardForm.StatusLabel.Update;
  Result := False;
  Rest := Sources;
  while (Rest <> '') and (not Result) do
  begin
    P := Pos(';', Rest);
    if P > 0 then
    begin
      Url := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest) - P);
    end
    else
    begin
      Url := Rest;
      Rest := '';
    end;
    if Url <> '' then Result := DownloadOne(Url, Target);
  end;
  if not Result then
    MsgBox('下载失败：' + ExtractFileName(Target) + #13#10 + '所有备用源都没成功。' + #13#10 +
           '可稍后在应用「设置 → 版本更新」里重试（那里有 5 个源可自动切换）。', mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then Exit;
  if WizardIsTaskSelected('ollama') then DownloadTo(OLLAMA_SOURCES, 'ollama\ollama-windows-amd64.zip');
  if WizardIsTaskSelected('melotts') then DownloadTo(MELOTTS_SOURCES, 'melotts\MeloTTS-main.zip');
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption :=
      '安装完成：绿色版已解压到所选目录，未请求管理员权限、未写入注册表。' + #13#10 + #13#10 +
      '开机自启请在应用「设置」里开启；开启时会写入当前用户的启动项' + #13#10 +
      '（HKCU\...\Run，仅自己生效，不需要管理员，也不会随安装器写入）。' + #13#10 + #13#10 +
      '计划数据存放在 %APPDATA%\PlanQuest\，与程序目录解耦，' + #13#10 +
      '以后换新版本直接沿用，不需要迁移。';
end;
